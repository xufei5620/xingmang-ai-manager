import { deflateSync, inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../lib/fixtures/generated-image-headers.json'
import { defaultImageTransformRecipe, type ImageLayer, type ImageLayerRecipe, type ImageTransformRecipe } from '../image-tools/recipe'
import type { ImageTransformDraw } from '../image-tools/geometry'
import { imageCollageTemplates } from '../image-tools/collage-templates'
import { createBrowserImageTransformer, paintBrowserImageLayerDocumentPreview, paintBrowserImageLayerFullPreview, processBrowserImageTransform, sampleBrowserImageLayerColor, sampleBrowserImageLayerPixels, type BrowserImageTransformBitmap, type BrowserImageTransformPlatform } from './browser-image-transform'
import { buildLayerFilterPresentationFrame } from '../image-tools/layer-filter-presentation'
import { defaultImageLayerColorGrade } from '../image-tools/layer-color-grade'
import { parseColorLutCube } from '../image-tools/layer-color-lut'
import { colorLutSourceKey, type ColorLutSelection } from '../image-tools/layer-color-lut-selection'
import { createBrowserLayerPsdExporter } from './browser-layer-psd'

function chunk(type: string, data: Uint8Array): Buffer {
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length)
  result.write(type, 4, 'ascii')
  result.set(data, 8)
  let crc = 0xffffffff
  for (const byte of result.subarray(4, result.length - 4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}

function png(width = 7, height = 5, rgba?: readonly number[]): Blob {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  // Pixel bytes are intentionally small; header budgets are tested before a real decoder runs.
  const data = width * height <= 4096 ? Buffer.alloc((width * 4 + 1) * height) : Buffer.alloc(5)
  if (rgba) for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) data.set(rgba, row * (width * 4 + 1) + column * 4 + 1)
  return new Blob([new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', new Uint8Array())]))], { type: 'image/png' })
}

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept }); return { promise, resolve } }
function sourceFixture(name: keyof typeof fixtures, type: string): Blob { return new Blob([new Uint8Array(Buffer.from(fixtures[name], 'base64'))], { type }) }

function fixture(dimensions = [{ width: 7, height: 5 }]) {
  const bitmaps = dimensions.map((size) => ({ ...size, close: vi.fn() }))
  const canvases: Array<{ width: number; height: number; fill: ReturnType<typeof vi.fn>; draws: ImageTransformDraw[]; dispose: ReturnType<typeof vi.fn> }> = []
  let index = 0
  const decode = vi.fn(async () => bitmaps[index++])
  const platform: BrowserImageTransformPlatform = {
    decode,
    createCanvas(width, height) {
      const canvas = { width, height, fill: vi.fn(), draws: [] as ImageTransformDraw[], dispose: vi.fn() }
      canvases.push(canvas)
      return { fill: canvas.fill, draw(_bitmap, command) { canvas.draws.push(command) }, encodePNG: () => Promise.resolve(png(width, height)), dispose: canvas.dispose }
    },
  }
  return { bitmaps, canvases, decode, platform, process: createBrowserImageTransformer(platform) }
}

const crop: ImageTransformRecipe = { kind: 'crop', x: 0, y: 0, width: 1, height: 1, outputWidth: 7, outputHeight: 5, rotation: 0, flipX: false, flipY: false }

function layerRecipe(content?: ImageLayer['content']): ImageLayerRecipe {
  return { kind: 'layer', outputWidth: 100, outputHeight: 80, background: 'transparent', layers: [{ sourceIndex: content ? 19 : 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, ...(content ? { content } : {}) }] }
}

function nativeCanvasFixture(filterSupported = true, deferEncoding = false, rasterSized = false) {
  function makeCanvas() {
    const calls: Array<[string, ...unknown[]]> = []
    const context = { imageSmoothingEnabled: false, imageSmoothingQuality: 'low', fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none', font: '', textBaseline: '', textAlign: '',
      save() { calls.push(['save']) }, restore() { calls.push(['restore']) },
      getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
      transform(...args: number[]) { calls.push(['transform', ...args]) }, setTransform(...args: number[]) { calls.push(['setTransform', ...args]) },
      getImageData: vi.fn((_x = 0, _y = 0, width = 1, height = 1) => ({ width, height, data: rasterSized ? Uint8ClampedArray.from({ length: width * height * 4 }, (_, index) => [21, 46, 50, 128][index % 4]) : new Uint8ClampedArray([21, 46, 50, 128]) })),
      createImageData(width: number, height: number) { return { width, height, data: new Uint8ClampedArray(width * height * 4) } },
      putImageData(...args: unknown[]) { calls.push(['putImageData', ...args]) },
      translate(...args: number[]) { calls.push(['translate', ...args]) }, scale(...args: number[]) { calls.push(['scale', ...args]) }, rotate(...args: number[]) { calls.push(['rotate', ...args]) },
      beginPath() { calls.push(['beginPath']) }, rect(...args: number[]) { calls.push(['rect', ...args]) }, ellipse(...args: number[]) { calls.push(['ellipse', ...args]) }, clip() { calls.push(['clip']) },
      arc(...args: number[]) { calls.push(['arc', ...args]) }, moveTo(...args: number[]) { calls.push(['moveTo', ...args]) }, lineTo(...args: number[]) { calls.push(['lineTo', ...args]) },
      closePath() { calls.push(['closePath']) }, bezierCurveTo(...args: number[]) { calls.push(['bezierCurveTo', ...args]) },
      clearRect(...args: number[]) { calls.push(['clearRect', ...args]) }, fillRect(...args: number[]) { calls.push(['fillRect', ...args]) }, fill() { calls.push(['fill', context.fillStyle]) }, stroke() { calls.push(['stroke', context.strokeStyle, context.lineWidth]) },
      measureText(text: string) { return { width: text.length * 8 } },
      fillText(...args: unknown[]) { calls.push(['fillText', ...args, { font: context.font, baseline: context.textBaseline, align: context.textAlign }]) },
      drawImage(...args: unknown[]) { calls.push(['drawImage', ...args, { alpha: context.globalAlpha, blend: context.globalCompositeOperation, filter: context.filter }]) },
    }
    if (!filterSupported) Reflect.deleteProperty(context, 'filter')
    const canvas = { width: 0, height: 0, allocated: [0, 0], calls, context, pendingEncode: null as ((blob: Blob | null) => void) | null, getContext: vi.fn(() => { canvas.allocated = [canvas.width, canvas.height]; return context }), toBlob(callback: (blob: Blob | null) => void) { if (deferEncoding) canvas.pendingEncode = callback; else callback(png(canvas.width, canvas.height)) } }
    Object.defineProperty(context, 'canvas', { value: canvas })
    return canvas
  }
  const canvases: ReturnType<typeof makeCanvas>[] = []
  vi.stubGlobal('document', { createElement: vi.fn(() => { const canvas = makeCanvas(); canvases.push(canvas); return canvas }) })
  const bitmap = { width: 7, height: 5, close: vi.fn() }
  const decode = vi.fn(async () => bitmap)
  vi.stubGlobal('createImageBitmap', decode)
  return { canvases, bitmap, decode }
}

/** Independent uniform-color canvas primitive. Its buffers really change on
 * fill/draw/put; PNG bytes are encoded from that buffer rather than a stub. */
function uniformPixelCanvasFixture() {
  const surfaces: Array<{ width: number; height: number; rgba: number[]; getContext(): CanvasRenderingContext2D; toBlob(done: (blob: Blob) => void): void }> = []
  function make() {
    const canvas = { width: 0, height: 0, rgba: [0, 0, 0, 0], getContext() { return context as unknown as CanvasRenderingContext2D }, toBlob(done: (blob: Blob) => void) { done(png(canvas.width, canvas.height, canvas.rgba)) } }
    const states: Array<{ fillStyle: string; globalAlpha: number; globalCompositeOperation: string; filter: string }> = []
    const context = {
      canvas, fillStyle: '#000000', globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none', imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
      save() { states.push({ fillStyle: context.fillStyle, globalAlpha: context.globalAlpha, globalCompositeOperation: context.globalCompositeOperation, filter: context.filter }) },
      restore() { Object.assign(context, states.pop()) },
      getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
      setTransform() {}, transform() {}, translate() {}, scale() {}, rotate() {}, beginPath() {}, rect() {}, clip() {}, closePath() {},
      clearRect() { canvas.rgba = [0, 0, 0, 0] },
      fill() { canvas.rgba = [parseInt(context.fillStyle.slice(1, 3), 16), parseInt(context.fillStyle.slice(3, 5), 16), parseInt(context.fillStyle.slice(5, 7), 16), 255] },
      fillRect() { context.fill() },
      drawImage(source: { rgba?: number[] }) { canvas.rgba = source.rgba ? [...source.rgba] : [0, 0, 0, 0] },
      getImageData(_x: number, _y: number, width: number, height: number) { return { width, height, data: new Uint8ClampedArray(Array.from({ length: width * height }, () => canvas.rgba).flat()) } },
      putImageData(value: ImageData) { canvas.rgba = [...value.data.slice(0, 4)] },
    }
    surfaces.push(canvas); return canvas
  }
  vi.stubGlobal('document', { createElement: make })
  return { make, surfaces }
}

function ownedLutPixels() {
  const table = parseColorLutCube('TITLE "Owned actual inverse"\nLUT_1D_SIZE 2\n1 1 1\n0 0 0'), lut: ColorLutSelection = { version: 1, enabled: true, strength: 100, source: { kind: 'asset', lutAssetId: 'a'.repeat(43), digest: 'b'.repeat(64), name: table.name, domainMin: [0, 0, 0], domainMax: [1, 1, 1] } }
  const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 2, outputHeight: 2, background: 'transparent', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, content: { kind: 'shape', shape: 'rectangle', fill: '#204060', stroke: 'transparent', strokeWidth: 0 }, colorGrade: { ...defaultImageLayerColorGrade(), lut } }] }
  return { table, lut, recipe, lutTables: new Map([[colorLutSourceKey(lut.source), table]]) }
}

async function pngPixelRows(blob: Blob): Promise<number[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer), idat: Uint8Array[] = []
  for (let at = 8; at + 12 <= bytes.length;) { const length = view.getUint32(at); if (String.fromCharCode(...bytes.slice(at + 4, at + 8)) === 'IDAT') idat.push(bytes.slice(at + 8, at + 8 + length)); at += 12 + length }
  return [...inflateSync(Buffer.concat(idat))]
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('owned browser image transformation', () => {
  it('carries owned LUT pixels through real PNG encoding, native sampling and PSD composite planes', async () => {
    const native = uniformPixelCanvasFixture(), f = ownedLutPixels()
    const [output] = await processBrowserImageTransform({ sources: [], recipe: f.recipe, lutTables: f.lutTables })
    const encoded = new Uint8Array(await output.blob.arrayBuffer()), idat: Uint8Array[] = [], pngView = new DataView(encoded.buffer)
    for (let at = 8; at + 12 <= encoded.length;) { const length = pngView.getUint32(at); if (String.fromCharCode(...encoded.slice(at + 4, at + 8)) === 'IDAT') idat.push(encoded.slice(at + 8, at + 8 + length)); at += 12 + length }
    expect([...inflateSync(Buffer.concat(idat))]).toEqual([0, 223, 191, 159, 255, 223, 191, 159, 255, 0, 223, 191, 159, 255, 223, 191, 159, 255])
    const pixels = await sampleBrowserImageLayerPixels({ recipe: f.recipe, sources: [], source: 'composite', lutTables: f.lutTables })
    expect([...pixels.data]).toEqual(Array.from({ length: 4 }, () => [223, 191, 159, 255]).flat())
    expect(await sampleBrowserImageLayerColor({ recipe: f.recipe, sources: [], point: { x: 0, y: 0 }, lutTables: f.lutTables })).toBe('#dfbf9fff')
    const psd = await createBrowserLayerPsdExporter({ async decode() { throw new Error('No bitmap sources expected') }, sample: sampleBrowserImageLayerPixels })({ recipe: f.recipe, sources: [], lutTables: f.lutTables })
    const bytes = new Uint8Array(await psd.blob.arrayBuffer()), view = new DataView(bytes.buffer)
    let at = 26; for (let section = 0; section < 3; section++) at += 4 + view.getUint32(at)
    expect(view.getUint16(at)).toBe(0)
    expect([...bytes.slice(at + 2)]).toEqual([223, 223, 223, 223, 191, 191, 191, 191, 159, 159, 159, 159, 255, 255, 255, 255])
    expect(native.surfaces.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it('rejects missing owned LUTs before decoding/encoding and preserves no-LUT output pixels', async () => {
    const native = uniformPixelCanvasFixture(), f = ownedLutPixels(), psd = createBrowserLayerPsdExporter({ async decode() { throw new Error('No sources') }, sample: sampleBrowserImageLayerPixels })
    await expect(processBrowserImageTransform({ sources: [], recipe: f.recipe })).rejects.toThrow(/LUT.*尚未准备/)
    await expect(sampleBrowserImageLayerPixels({ recipe: f.recipe, sources: [], source: 'composite' })).rejects.toThrow(/LUT.*尚未准备/)
    await expect(sampleBrowserImageLayerColor({ recipe: f.recipe, sources: [], point: { x: 0, y: 0 } })).rejects.toThrow(/LUT.*尚未准备/)
    await expect(psd({ recipe: f.recipe, sources: [] })).rejects.toThrow(/LUT.*尚未准备/)
    expect(native.surfaces).toHaveLength(0)
    f.recipe.layers[0].colorGrade = undefined
    expect([...((await sampleBrowserImageLayerPixels({ recipe: f.recipe, sources: [], source: 'composite' })).data)]).toEqual(Array.from({ length: 4 }, () => [32, 64, 96, 255]).flat())
  })

  it('captures a LUT map before an asynchronous draw and does not publish cancelled PNG or PSD work', async () => {
    uniformPixelCanvasFixture(); const f = ownedLutPixels(), controller = new AbortController()
    const pending = processBrowserImageTransform({ sources: [], recipe: f.recipe, lutTables: f.lutTables })
    f.table.data.fill(0); f.lutTables.clear()
    const output = await pending
    expect(await pngPixelRows(output[0].blob)).toEqual([0, 223, 191, 159, 255, 223, 191, 159, 255, 0, 223, 191, 159, 255, 223, 191, 159, 255])
    const another = ownedLutPixels(), exporting = processBrowserImageTransform({ sources: [], recipe: another.recipe, lutTables: another.lutTables, signal: controller.signal })
    controller.abort(); await expect(exporting).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('replays the same LUT in cropped document and full-layer preview paths and fails closed without it', async () => {
    const native = uniformPixelCanvasFixture(), f = ownedLutPixels(), target = native.make(); target.width = 2; target.height = 2
    const cropped = { ...f.recipe, documentFrame: { version: 1 as const, width: 4, height: 4, offsetX: 1, offsetY: 1 } }
    await expect(paintBrowserImageLayerDocumentPreview(target.getContext(), { recipe: cropped, sources: [] })).rejects.toThrow(/LUT.*尚未准备/)
    expect(target.rgba).toEqual([0, 0, 0, 0])
    await paintBrowserImageLayerDocumentPreview(target.getContext(), { recipe: cropped, sources: [], lutTables: f.lutTables })
    expect(target.rgba).toEqual([223, 191, 159, 255])
    await expect(paintBrowserImageLayerFullPreview(target.getContext(), { recipe: f.recipe, layerIndex: 0 })).rejects.toThrow(/LUT.*尚未准备/)
    await paintBrowserImageLayerFullPreview(target.getContext(), { recipe: f.recipe, layerIndex: 0, lutTables: f.lutTables })
    expect(target.rgba).toEqual([223, 191, 159, 255])
  })

  it('cancels actual LUT PSD sampling and releases every temporary pixel surface', async () => {
    const native = uniformPixelCanvasFixture(), f = ownedLutPixels(), controller = new AbortController()
    const pending = createBrowserLayerPsdExporter({ async decode() { throw new Error('No bitmap sources expected') }, sample: sampleBrowserImageLayerPixels })({ recipe: f.recipe, sources: [], lutTables: f.lutTables, signal: controller.signal })
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(native.surfaces.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it('extends the full layer then copies the exact old replay domain before inverse-only presentation', async () => {
    const native = nativeCanvasFixture(true, false, true), recipe = layerRecipe(), canvas = document.createElement('canvas')
    recipe.outputWidth = 40; recipe.outputHeight = 30; recipe.explicitLayers = true; recipe.documentFrame = { version: 1, width: 100, height: 80, offsetX: 20, offsetY: 30 }
    recipe.layers[0] = { ...recipe.layers[0], x: -.5, y: -1, width: 5, height: 160 / 30, rotation: 30, opacity: .5, blend: 'multiply' }
    const before = JSON.stringify(recipe), frame = buildLayerFilterPresentationFrame(recipe, 0)
    canvas.width = 200; canvas.height = 160
    await paintBrowserImageLayerFullPreview(canvas.getContext('2d')!, { recipe, layerIndex: 0, source: { image: native.bitmap as unknown as CanvasImageSource, width: 7, height: 5 } })
    const complete = native.canvases.find((item) => item.calls.some(([name]) => name === 'rect' && item.calls.some((call) => call[0] === 'drawImage' && call.length === 11)))!
    const canonical = native.canvases.find((item) => item !== native.canvases[0] && item.allocated[0] === 100 && item.allocated[1] === 80)!
    const copy = complete.calls.find((call) => call[0] === 'drawImage' && call[1] === canonical)!
    expect(copy.at(-1)).toMatchObject({ alpha: 1, blend: 'copy', filter: 'none' })
    expect(copy.slice(2, 6)).toEqual([0, 0, 100, 80])
    expect(copy.slice(6, 10)).toEqual([-20 - frame.worldBounds.x, -30 - frame.worldBounds.y, 100, 80])
    expect(canonical.calls.find(([name]) => name === 'translate')).toEqual(['translate', 100, 80])
    const finalDraw = native.canvases[0].calls.filter(([name]) => name === 'drawImage')
    expect(finalDraw).toHaveLength(1); expect(finalDraw[0][1]).toBe(complete)
    expect(JSON.stringify(recipe)).toBe(before)
    expect(native.canvases.slice(1).every((item) => item.width === 0 && item.height === 0)).toBe(true)
  })

  it.each(['blur', 'liquify', 'neutral', 'whole'] as const)('preserves canonical %s replay and applies legacy adjustments once per independent pass', async (kind) => {
    const native = nativeCanvasFixture(true, false, true), recipe = layerRecipe({ kind: 'paint' }), canvas = document.createElement('canvas')
    recipe.outputWidth = 40; recipe.outputHeight = 30; recipe.explicitLayers = true; recipe.documentFrame = { version: 1, width: 100, height: 80, offsetX: 20, offsetY: 30 }
    recipe.layers[0] = { ...recipe.layers[0], x: -.5, y: -1, width: 2.5, height: 80 / 30, mask: { kind: 'rectangle', transform: [1, 0, 0, 1, 0, 0], inverted: false }, adjustments: { brightness: 1.1, contrast: 1, saturation: 1, blur: 0, grayscale: 0 } }
    recipe.layers[0].edits = { version: 1, operations: kind === 'blur' ? [{ mode: 'blur', points: [[5000, 5000]], size: 10, strength: 1, space: { width: 100, height: 80 } }] : kind === 'liquify' ? [{ mode: 'liquify', version: 1, space: { width: 100, height: 80 }, strokes: [{ tool: 'push', radius: 10, strength: .5, points: [[4000, 5000], [6000, 5000]] }] }] : [{ mode: 'whole-filter', version: 1, filter: { type: 'gaussian', parameters: { radius: kind === 'neutral' ? 0 : 1 } }, space: { width: 100, height: 80 } }] }
    canvas.width = 100; canvas.height = 80
    await paintBrowserImageLayerFullPreview(canvas.getContext('2d')!, { recipe, layerIndex: 0 })
    const canonical = native.canvases.find((item) => item !== native.canvases[0] && item.allocated[0] === 100 && item.allocated[1] === 80)!
    expect(canonical).toBeDefined()
    expect(canonical.calls.filter((call) => call[0] === 'drawImage' && (call.at(-1) as { filter: string }).filter.startsWith('brightness(1.1)'))).toHaveLength(1)
    const copies = native.canvases.flatMap((item) => item.calls).filter((call) => call[0] === 'drawImage' && (call.at(-1) as { blend: string }).blend === 'copy')
    expect(copies).toHaveLength(1); expect(copies[0].at(-1)).toMatchObject({ alpha: 1, filter: 'none' })
    expect(native.canvases[0].calls.filter(([name]) => name === 'drawImage')).toHaveLength(1)
    expect(native.canvases.slice(1).every((item) => item.width === 0 && item.height === 0)).toBe(true)
  })

  it('does not publish a cancelled full layer preview and releases every temporary surface', async () => {
    const native = nativeCanvasFixture(true, false, true), recipe = layerRecipe({ kind: 'paint' }), canvas = document.createElement('canvas'), controller = new AbortController()
    recipe.layers[0].edits = { version: 1, operations: [{ mode: 'whole-filter', version: 1, filter: { type: 'gaussian', parameters: { radius: 80 } }, space: { width: 100, height: 80 } }] }
    canvas.width = 100; canvas.height = 80
    const pending = paintBrowserImageLayerFullPreview(canvas.getContext('2d')!, { recipe, layerIndex: 0, signal: controller.signal })
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(native.canvases[0].calls).toEqual([])
    expect(native.canvases.slice(1).every((item) => item.width === 0 && item.height === 0)).toBe(true)
    await expect(paintBrowserImageLayerFullPreview(canvas.getContext('2d')!, { recipe, layerIndex: 0, deadline: 0 })).rejects.toThrow('超时')
  })

  it('replays a cropped bitmap in the original document surface and clips only the final output', async () => {
    const native = nativeCanvasFixture(), recipe = layerRecipe()
    recipe.outputWidth = 40; recipe.outputHeight = 30
    recipe.explicitLayers = true; recipe.documentFrame = { version: 1, width: 100, height: 80, offsetX: 20, offsetY: 30 }
    recipe.layers[0] = { ...recipe.layers[0], x: -.5, y: -1, width: 2.5, height: 80 / 30 }
    const result = await processBrowserImageTransform({ sources: [png()], recipe })
    expect(result).toMatchObject([{ width: 40, height: 30 }])
    const [replay, output] = native.canvases
    expect(output.allocated).toEqual([40, 30]); expect(replay.allocated).toEqual([100, 80])
    expect(replay.context.imageSmoothingQuality).toBe('high')
    expect(replay.calls.find(([name]) => name === 'translate')).toEqual(['translate', 50, 40])
    expect(replay.calls.some(([name]) => name === 'drawImage')).toBe(true)
    expect(output.calls.find(([name]) => name === 'drawImage')?.slice(2, 4)).toEqual([-20, -30])
    expect(native.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
    expect(native.bitmap.close).toHaveBeenCalledOnce()
  })
  it('keeps the original blur halo for cropped sampling and uses the visible output origin', async () => {
    const native = nativeCanvasFixture(), recipe = layerRecipe({ kind: 'shape', shape: 'rectangle', fill: '#ff0000', stroke: 'transparent', strokeWidth: 0 })
    recipe.outputWidth = 40; recipe.outputHeight = 30
    recipe.explicitLayers = true; recipe.documentFrame = { version: 1, width: 100, height: 80, offsetX: 20, offsetY: 30 }
    recipe.layers[0] = { ...recipe.layers[0], adjustments: { brightness: 1, contrast: 1, saturation: 1, blur: 2, grayscale: 0 } }
    await sampleBrowserImageLayerColor({ recipe, sources: [], point: { x: 5, y: 7 } })
    const [output, replay] = native.canvases
    expect(replay.allocated).toEqual([120, 100])
    expect(output.allocated).toEqual([100, 80])
    expect(replay.calls[0]).toEqual(['translate', 10, 10])
    expect(output.calls.find(([name]) => name === 'drawImage')?.slice(2, 4)).toEqual([-10, -10])
    expect(output.context.getImageData).toHaveBeenCalledWith(25, 37, 1, 1)
    expect(native.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })
  it('renders a cropped preview with the native replay path before reducing its pixels', async () => {
    const native = nativeCanvasFixture(), recipe = layerRecipe({ kind: 'shape', shape: 'rectangle', fill: '#ff0000', stroke: 'transparent', strokeWidth: 0 })
    recipe.outputWidth = 40; recipe.outputHeight = 30
    recipe.explicitLayers = true; recipe.documentFrame = { version: 1, width: 100, height: 80, offsetX: 20, offsetY: 30 }
    const target = document.createElement('canvas'); target.width = 20; target.height = 15
    const context = target.getContext('2d')!
    await paintBrowserImageLayerDocumentPreview(context, { recipe, sources: [] })
    expect(native.canvases.map((canvas) => canvas.allocated)).toEqual([[20, 15], [100, 80], [100, 80]])
    expect(native.canvases[0].calls.find(([name]) => name === 'drawImage')?.slice(2, 10)).toEqual([20, 30, 40, 30, 0, 0, 20, 15])
    expect(native.canvases.slice(1).every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
    expect(target.width).toBe(20)
  })
  it('rejects an invalid replay domain before allocating output or decoding sources', async () => {
    const native = nativeCanvasFixture(), recipe = layerRecipe()
    recipe.explicitLayers = true; recipe.documentFrame = { version: 1, width: 4097, height: 80, offsetX: 0, offsetY: 0 }
    await expect(processBrowserImageTransform({ sources: [png()], recipe })).rejects.toThrow()
    expect(native.canvases).toHaveLength(0); expect(native.decode).not.toHaveBeenCalled()
  })
  it('does not publish a cancelled document preview', async () => {
    const native = nativeCanvasFixture(), recipe = layerRecipe({ kind: 'shape', shape: 'rectangle', fill: '#ff0000', stroke: 'transparent', strokeWidth: 0 })
    recipe.explicitLayers = true; recipe.documentFrame = { version: 1, width: 100, height: 80, offsetX: 0, offsetY: 0 }
    const target = document.createElement('canvas'); target.width = 20; target.height = 15
    const controller = new AbortController(); controller.abort()
    await expect(paintBrowserImageLayerDocumentPreview(target.getContext('2d')!, { recipe, sources: [], signal: controller.signal })).rejects.toThrow('已取消')
    expect(native.canvases).toHaveLength(1)
    expect(native.canvases[0].calls.filter(([name]) => name === 'drawImage')).toEqual([])
  })
  it('releases both crop canvases immediately when encoding is cancelled before its callback', async () => {
    const native = nativeCanvasFixture(true, true), recipe = layerRecipe()
    recipe.outputWidth = 40; recipe.outputHeight = 30; recipe.explicitLayers = true
    recipe.documentFrame = { version: 1, width: 100, height: 80, offsetX: 20, offsetY: 30 }
    const controller = new AbortController(), result = processBrowserImageTransform({ sources: [png()], recipe, signal: controller.signal })
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(native.canvases[1]?.pendingEncode).toBeTypeOf('function'))
    controller.abort(); await rejected
    expect(native.canvases).toHaveLength(2)
    expect(native.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
    native.canvases[1].pendingEncode!(png(40, 30)); await Promise.resolve()
    expect(native.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
    expect(native.bitmap.close).toHaveBeenCalledOnce()
  })
  it('checks annotation dimensions against oriented decoded pixels without decoding twice', async () => {
    const context = fixture([{ width: 5, height: 7 }])
    const output = await context.process({ sources: [png()], recipe: { ...crop, outputWidth: 5, outputHeight: 7 }, expectedSourceSizes: [{ width: 5, height: 7 }] })
    expect(output).toMatchObject([{ width: 5, height: 7 }])
    expect(context.decode).toHaveBeenCalledOnce()
    expect(context.bitmaps[0].close).toHaveBeenCalledOnce()
  })

  it('rejects a decoded dimension mismatch before allocating or drawing output', async () => {
    const context = fixture([{ width: 5, height: 7 }])
    await expect(context.process({ sources: [png()], recipe: crop, expectedSourceSizes: [{ width: 7, height: 5 }] })).rejects.toThrow('实际尺寸已变化')
    expect(context.canvases).toHaveLength(0)
    expect(context.bitmaps[0].close).toHaveBeenCalledOnce()
  })

  it.each([[], [{ width: 0, height: 5 }], [{ width: 7.1, height: 5 }], [{ width: 4097, height: 5 }]].map((expectedSourceSizes) => ({ expectedSourceSizes })))('rejects invalid expected source sizes before decoding: %j', async ({ expectedSourceSizes }) => {
    const context = fixture()
    await expect(context.process({ sources: [png()], recipe: crop, expectedSourceSizes })).rejects.toThrow('尺寸约束')
    expect(context.decode).not.toHaveBeenCalled()
  })

  it.each(imageCollageTemplates)('encodes all ordered $title sources into one fixed-size PNG', async (template) => {
    const sizes = [{ width: 7, height: 5 }, { width: 5, height: 7 }, { width: 9, height: 3 }].slice(0, template.inputCount)
    const context = fixture(sizes)
    const result = await context.process({ sources: sizes.map((size) => png(size.width, size.height)), recipe: { ...defaultImageTransformRecipe('collage'), kind: 'collage', rows: 1, columns: 1, gap: 0, padding: 0, outputWidth: 80, outputHeight: 60, fit: 'cover', background: 'transparent', layout: template.layout } })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ width: 80, height: 60 })
    expect(result[0].blob.type).toBe('image/png')
    expect(context.canvases[0].draws.map((command) => command.sourceIndex)).toEqual(sizes.map((_, index) => index))
    expect(context.canvases[0].draws.reduce((sum, command) => sum + command.destination.width * command.destination.height, 0)).toBe(80 * 60)
    expect(context.canvases[0].dispose).toHaveBeenCalledOnce()
    expect(context.bitmaps.every((bitmap) => bitmap.close.mock.calls.length === 1)).toBe(true)
  })
  it('renders collage decoration and watermark into the final native PNG and releases all surfaces', async () => {
    const native = nativeCanvasFixture()
    const recipe: ImageTransformRecipe = { kind: 'collage', rows: 1, columns: 2, gap: 12, padding: 20, outputWidth: 240, outputHeight: 120, fit: 'contain', background: 'transparent', cornerRadius: 16, borderWidth: 4, borderColor: '#abcdef', shadow: true, watermark: { text: '星芒', color: '#ffffff80', opacity: 0.4, fontSize: 24 } }
    const output = await processBrowserImageTransform({ sources: [png(), png()], recipe })
    expect(output.map(({ width, height }) => ({ width, height }))).toEqual([{ width: 240, height: 120 }])
    const calls = native.canvases[0].calls
    expect(calls.filter((call) => call[0] === 'stroke')).toHaveLength(2)
    const watermarkIndex = calls.findIndex((call) => call[0] === 'fillText')
    expect(watermarkIndex).toBeGreaterThan(calls.map((call) => call[0] === 'drawImage').lastIndexOf(true))
    expect(calls[watermarkIndex][1]).toBe('星芒')
    expect(native.canvases).toHaveLength(3)
    expect(native.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })
  it('encodes auto collage dimensions from decoded orientation instead of stored fixed output', async () => {
    const sizes = [{ width: 640, height: 480 }, { width: 480, height: 640 }, { width: 960, height: 320 }]
    const context = fixture(sizes)
    const recipe: ImageTransformRecipe = { kind: 'collage', rows: 1, columns: 1, gap: 0, padding: 0, outputWidth: 100, outputHeight: 100, fit: 'contain', background: 'transparent', layout: 'horizontal', autoSize: true }
    const result = await context.process({ sources: sizes.map((size) => png(size.height, size.width)), recipe })
    expect(result[0]).toMatchObject({ width: 3253, height: 640 })
    expect(context.canvases[0].draws.map((command) => command.sourceIndex)).toEqual([0, 1, 2])
    expect(context.bitmaps.every((bitmap) => bitmap.close.mock.calls.length === 1)).toBe(true)
  })
  it('reads a native pixel region after full-origin compositing and isolates the requested current layer', async () => {
    const native = nativeCanvasFixture(), recipe = layerRecipe({ kind: 'shape', shape: 'rectangle', fill: '#abcdef', stroke: 'transparent', strokeWidth: 0 })
    recipe.background = '#123456'
    recipe.layers.push({ ...recipe.layers[0], opacity: 0.5, blend: 'screen', adjustments: { brightness: 1, contrast: 1, saturation: 1, blur: 3, grayscale: 0 } })
    const result = await sampleBrowserImageLayerPixels({ recipe, sources: [], source: 'current', layerIndex: 1, region: { x: 10, y: 20, width: 1, height: 1 } })
    expect(result).toEqual({ width: 1, height: 1, data: new Uint8ClampedArray([21, 46, 50, 128]) })
    expect(native.canvases.map((canvas) => canvas.allocated)).toEqual([[100, 80], [128, 108]])
    expect(native.canvases[0].calls.some(([name]) => name === 'fillRect')).toBe(false)
    expect(native.canvases[0].calls.filter(([name]) => name === 'drawImage')).toHaveLength(1)
    expect(native.canvases[0].context.getImageData).toHaveBeenCalledWith(10, 20, 1, 1)
    expect(native.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
    expect(native.decode).not.toHaveBeenCalled()
    await sampleBrowserImageLayerPixels({ recipe, sources: [], source: 'composite' })
    expect(native.canvases[2].calls.filter(([name]) => name === 'drawImage')).toHaveLength(2)
    expect(native.canvases[2].calls.find(([name]) => name === 'fillRect')).toEqual(['fillRect', 0, 0, 100, 80])
    expect(native.canvases[2].context.getImageData).toHaveBeenCalledWith(0, 0, 100, 80)
  })

  it('validates pixel regions and current layer identity before allocation and releases unsafe or cancelled reads', async () => {
    const native = nativeCanvasFixture(), recipe = layerRecipe({ kind: 'paint' }), controller = new AbortController()
    for (const region of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 101, height: 1 }, { x: 0.5, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }]) await expect(sampleBrowserImageLayerPixels({ recipe, sources: [], source: 'composite', region })).rejects.toThrow('取样区域')
    await expect(sampleBrowserImageLayerPixels({ recipe, sources: [], source: 'current', layerIndex: 1 })).rejects.toThrow('选择')
    expect(native.canvases).toHaveLength(0)
    const pending = sampleBrowserImageLayerPixels({ recipe, sources: [], source: 'composite' })
    native.canvases[0].context.getImageData.mockImplementation(() => { throw new Error('SecurityError') })
    await expect(pending).rejects.toThrow('不能安全读取')
    controller.abort()
    await expect(sampleBrowserImageLayerPixels({ recipe, sources: [], source: 'composite', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(native.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })
  it('samples with the exact export surface and origin so browser filter rasterization does not drift', async () => {
    const native = nativeCanvasFixture(), recipe = layerRecipe({ kind: 'shape', shape: 'rectangle', fill: '#ffffff', stroke: 'transparent', strokeWidth: 0 })
    recipe.outputWidth = 4096; recipe.outputHeight = 4096
    recipe.layers[0].opacity = 0.4; recipe.layers[0].blend = 'multiply'
    recipe.layers[0].adjustments = { brightness: 1, contrast: 1, saturation: 1, blur: 32, grayscale: 0 }
    expect(await sampleBrowserImageLayerColor({ recipe, sources: [], point: { x: 3000.8, y: 2000.5 } })).toBe('#152e3280')
    expect(native.canvases.map((canvas) => canvas.allocated)).toEqual([[4096, 4096], [4356, 4356]])
    expect(native.canvases[0].context.getImageData).toHaveBeenCalledWith(3000, 2000, 1, 1)
    expect(native.canvases[0].calls.some(([name]) => name === 'translate')).toBe(false)
    expect(native.canvases[0].calls.find(([name]) => name === 'drawImage')).toEqual(['drawImage', native.canvases[1], -130, -130, { alpha: 0.4, blend: 'multiply', filter: 'brightness(1) contrast(1) saturate(1) blur(32px) grayscale(0)' }])
    expect(native.decode).not.toHaveBeenCalled()
    expect(native.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it('rejects unsafe readback and cancelled color sampling without retaining temporary surfaces', async () => {
    const native = nativeCanvasFixture(), recipe = layerRecipe({ kind: 'paint' }), controller = new AbortController()
    controller.abort()
    await expect(sampleBrowserImageLayerColor({ recipe, sources: [], point: { x: 1, y: 1 }, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(sampleBrowserImageLayerColor({ recipe, sources: [], point: { x: 100, y: 1 } })).rejects.toThrow('画布范围')
    expect(native.canvases).toHaveLength(0)
    const pending = sampleBrowserImageLayerColor({ recipe, sources: [], point: { x: 1, y: 1 } })
    native.canvases[0].context.getImageData.mockImplementation(() => { throw new Error('SecurityError') })
    await expect(pending).rejects.toThrow('不能安全取色')
    expect(native.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it('keeps full-size feathered layer composition while a background-only canvas uses one pixel', async () => {
    const native = nativeCanvasFixture(), recipe = layerRecipe({ kind: 'paint' })
    recipe.outputWidth = 1000; recipe.outputHeight = 800
    recipe.layers[0].rotation = 45
    recipe.layers[0].mask = { kind: 'ellipse', transform: [1, 0, 0, 1, 0, 0], inverted: false, feather: { radius: 5, space: { width: 1000, height: 800 } } }
    await sampleBrowserImageLayerColor({ recipe, sources: [], point: { x: 500, y: 400 } })
    expect(native.canvases.map((canvas) => canvas.allocated)).toEqual([[1000, 800], [1000, 800]])
    expect(native.canvases[0].context.getImageData).toHaveBeenCalledWith(500, 400, 1, 1)
    await sampleBrowserImageLayerColor({ recipe: { ...recipe, layers: [], explicitLayers: true }, sources: [], point: { x: 500, y: 400 } })
    expect(native.canvases[2].allocated).toEqual([1, 1])
    expect(native.canvases[2].context.getImageData).toHaveBeenCalledWith(0, 0, 1, 1)
  })

  it('exports transparent painting without a source decoder and merges its isolated edit surface only once', async () => {
    const context = nativeCanvasFixture()
    const recipe = layerRecipe({ kind: 'paint' })
    recipe.layers[0].opacity = 0.4
    recipe.layers[0].edits = { version: 1, operations: ['paint', 'erase', 'paint'].map((mode) => ({ mode: mode as 'paint' | 'erase', points: [[1000, 1000], [9000, 9000]], size: 30, hardness: 1, opacity: 0.7, color: '#ff0000', space: { width: 100, height: 80 } })) }
    expect(await processBrowserImageTransform({ sources: [], recipe })).toMatchObject([{ width: 100, height: 80, blob: expect.any(Blob) }])
    expect(context.decode).not.toHaveBeenCalled()
    expect(context.canvases).toHaveLength(2)
    expect(context.canvases[1].calls.filter(([name]) => name === 'stroke')).toHaveLength(3)
    expect(context.canvases[0].calls.filter(([name]) => name === 'drawImage')).toEqual([['drawImage', context.canvases[1], -0, -0, { alpha: 0.4, blend: 'source-over', filter: 'none' }]])
    expect(context.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })
  it('encodes PNG outputs in row-major order and releases each canvas and input bitmap', async () => {
    const context = fixture()
    const result = await context.process({ sources: [png()], recipe: { kind: 'grid-split', rows: 2, columns: 2, gap: 0, padding: 0 } })
    expect(result.map(({ width, height, blob }) => [width, height, blob.type])).toEqual([[3, 2, 'image/png'], [4, 2, 'image/png'], [3, 3, 'image/png'], [4, 3, 'image/png']])
    expect(context.canvases.map((value) => value.draws[0].source)).toEqual([{ x: 0, y: 0, width: 3, height: 2 }, { x: 3, y: 0, width: 4, height: 2 }, { x: 0, y: 2, width: 3, height: 3 }, { x: 3, y: 2, width: 4, height: 3 }])
    expect(context.canvases.every((value) => value.dispose.mock.calls.length === 1)).toBe(true)
    expect(context.bitmaps[0].close).toHaveBeenCalledTimes(1)
  })

  it.each([['baseline', 'image/jpeg'], ['progressive', 'image/jpeg'], ['lossy', 'image/webp'], ['lossless', 'image/webp'], ['extended', 'image/webp'], ['palette', 'image/png']] as const)('accepts validated %s static containers', async (name, type) => {
    const context = fixture()
    expect(await context.process({ sources: [sourceFixture(name, type)], recipe: crop })).toHaveLength(1)
    expect(context.decode).toHaveBeenCalledTimes(1)
  })

  it('uses oriented decoder dimensions for crop geometry without losing orientation metadata before decode', async () => {
    const context = fixture([{ width: 5, height: 7 }])
    const result = await context.process({ sources: [sourceFixture('baseline', 'image/jpeg')], recipe: crop })
    expect(result).toHaveLength(1)
    expect(context.canvases[0].draws[0].source).toEqual({ x: 0, y: 0, width: 5, height: 7 })
  })

  it.each([['animated', 'image/webp'], ['apng', 'image/png']] as const)('rejects %s instead of silently flattening animation', async (name, type) => {
    const context = fixture()
    await expect(context.process({ sources: [sourceFixture(name, type)], recipe: crop })).rejects.toThrow('静态图片')
    expect(context.decode).not.toHaveBeenCalled()
  })

  it('validates every input before decoding any image and rejects misleading media types', async () => {
    const context = fixture()
    await expect(context.process({ sources: [png(), new Blob(['invalid'], { type: 'image/png' })], recipe: defaultImageTransformRecipe('collage') })).rejects.toThrow('结构或尺寸无效')
    await expect(context.process({ sources: [new Blob([await png().arrayBuffer()], { type: 'image/jpeg' })], recipe: crop })).rejects.toThrow('实际文件不一致')
    expect(context.decode).not.toHaveBeenCalled()
  })

  it('rejects oversized dimensions and aggregate pixels before the image decoder allocates memory', async () => {
    const context = fixture()
    await expect(context.process({ sources: [png(16385, 1)], recipe: crop })).rejects.toThrow('结构或尺寸无效')
    await expect(context.process({ sources: [png(4096, 4096), png(4096, 4096), png(1, 1)], recipe: defaultImageTransformRecipe('collage') })).rejects.toThrow('总像素')
    expect(context.decode).not.toHaveBeenCalled()
  })

  it('rejects excessive byte counts, unsupported formats and input counts without reading bytes', async () => {
    const context = fixture()
    await expect(context.process({ sources: [new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: 'image/png' })], recipe: crop })).rejects.toThrow('单张不超过')
    await expect(context.process({ sources: [new Blob(['svg'], { type: 'image/svg+xml' })], recipe: crop })).rejects.toThrow('PNG')
    await expect(context.process({ sources: Array.from({ length: 21 }, () => png()), recipe: crop })).rejects.toThrow('20')
    expect(context.decode).not.toHaveBeenCalled()
  })

  it('rejects unexpected decoded dimensions and still closes that bitmap', async () => {
    const context = fixture([{ width: 8, height: 5 }])
    await expect(context.process({ sources: [png()], recipe: crop })).rejects.toThrow('尺寸与文件信息不一致')
    expect(context.bitmaps[0].close).toHaveBeenCalledTimes(1)
    expect(context.canvases).toEqual([])
  })

  it('releases earlier bitmaps when decoding a later source fails', async () => {
    const context = fixture()
    context.decode.mockImplementationOnce(async () => context.bitmaps[0]).mockRejectedValueOnce(new Error('native codec failure'))
    await expect(context.process({ sources: [png(), png()], recipe: defaultImageTransformRecipe('collage') })).rejects.toThrow('浏览器无法解码')
    expect(context.bitmaps[0].close).toHaveBeenCalledTimes(1)
  })

  it('aborts before reading source bytes without allocating decoder resources', async () => {
    const context = fixture()
    const controller = new AbortController()
    controller.abort('private caller reason')
    await expect(context.process({ sources: [png()], recipe: crop, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', message: '已取消图像处理，当前画布没有改变' })
    expect(context.decode).not.toHaveBeenCalled()
  })

  it('rejects promptly during decode and closes a bitmap arriving after cancellation', async () => {
    const context = fixture()
    const pendingDecode = deferred<BrowserImageTransformBitmap>()
    const started = deferred<void>()
    context.platform.decode = () => { started.resolve(); return pendingDecode.promise }
    const controller = new AbortController()
    const pending = context.process({ sources: [png()], recipe: crop, signal: controller.signal })
    await started.promise
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    pendingDecode.resolve(context.bitmaps[0])
    await Promise.resolve()
    expect(context.bitmaps[0].close).toHaveBeenCalledTimes(1)
    expect(context.canvases).toHaveLength(0)
  })

  it('aborts an encoding and releases its canvas before the encoder finishes', async () => {
    const context = fixture()
    const encoding = deferred<Blob>()
    const started = deferred<void>()
    const dispose = vi.fn()
    context.platform.createCanvas = () => ({ fill() {}, draw() {}, encodePNG() { started.resolve(); return encoding.promise }, dispose })
    const controller = new AbortController()
    const pending = context.process({ sources: [png()], recipe: crop, signal: controller.signal })
    await started.promise
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(context.bitmaps[0].close).toHaveBeenCalledTimes(1)
    encoding.resolve(png())
  })

  it('keeps a deadline while decoding and closes late results after timeout', async () => {
    vi.useFakeTimers()
    const context = fixture()
    const pendingDecode = deferred<BrowserImageTransformBitmap>()
    const started = deferred<void>()
    context.platform.decode = () => { started.resolve(); return pendingDecode.promise }
    const pending = context.process({ sources: [png()], recipe: crop })
    const rejected = expect(pending).rejects.toThrow('等待超时')
    await started.promise
    await vi.advanceTimersByTimeAsync(45_001)
    await rejected
    pendingDecode.resolve(context.bitmaps[0])
    await Promise.resolve()
    expect(context.bitmaps[0].close).toHaveBeenCalledTimes(1)
  })

  it('does not return a partial output set when a later PNG fails', async () => {
    const context = fixture()
    const original = context.platform.createCanvas
    let count = 0
    context.platform.createCanvas = (width, height) => {
      const canvas = original(width, height)
      if (++count === 2) canvas.encodePNG = () => Promise.resolve(new Blob(['bad'], { type: 'image/png' }))
      return canvas
    }
    await expect(context.process({ sources: [png()], recipe: { kind: 'grid-split', rows: 2, columns: 2, gap: 0, padding: 0 } })).rejects.toThrow()
    expect(context.canvases).toHaveLength(2)
    expect(context.canvases.every((value) => value.dispose.mock.calls.length === 1)).toBe(true)
    expect(context.bitmaps[0].close).toHaveBeenCalledTimes(1)
  })

  it('checks actual encoded PNG dimensions before returning an output', async () => {
    const context = fixture()
    const dispose = vi.fn()
    context.platform.createCanvas = () => ({ fill() {}, draw() {}, encodePNG: () => Promise.resolve(png(1, 1)), dispose })
    await expect(context.process({ sources: [png()], recipe: crop })).rejects.toThrow('实际尺寸')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('snapshots sources so a caller cannot swap an unvalidated blob into a pending decode', async () => {
    const context = fixture()
    const original = png()
    const sources = [original]
    const pending = context.process({ sources, recipe: crop })
    sources[0] = new Blob(['unvalidated'], { type: 'image/png' })
    sources.push(png())
    await pending
    expect(context.decode).toHaveBeenCalledExactlyOnceWith(original)
  })

  it('uses real Canvas2D transform ordering and EXIF-aware bitmap decoding', async () => {
    const bitmap = { width: 7, height: 5, close: vi.fn() }
    const calls: Array<[string, ...unknown[]]> = []
    const context = { imageSmoothingEnabled: false, imageSmoothingQuality: 'low', fillStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
      save: () => calls.push(['save']), restore: () => calls.push(['restore']), fillRect: (...args: number[]) => calls.push(['fillRect', ...args]),
      translate: (...args: number[]) => calls.push(['translate', ...args]), scale: (...args: number[]) => calls.push(['scale', ...args]), rotate: (...args: number[]) => calls.push(['rotate', ...args]), drawImage: (...args: unknown[]) => calls.push(['drawImage', ...args]) }
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toBlob(callback: (blob: Blob | null) => void, type: string) { expect(type).toBe('image/png'); callback(png(7, 5)) } }
    const decode = vi.fn(async () => bitmap)
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })
    vi.stubGlobal('createImageBitmap', decode)
    await processBrowserImageTransform({ sources: [png()], recipe: { ...crop, rotation: 90, flipX: true } })
    expect(decode).toHaveBeenCalledWith(expect.any(Blob), { imageOrientation: 'from-image' })
    expect(calls.map((value) => value[0])).toEqual(['save', 'translate', 'scale', 'rotate', 'drawImage', 'restore'])
    expect(calls[1]).toEqual(['translate', 3.5, 2.5])
    expect(calls[2]).toEqual(['scale', -1, 1])
    expect(calls[3]).toEqual(['rotate', Math.PI / 2])
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  it('renders source-free text with explicit newlines, output-pixel font size and clipping without squeezing', async () => {
    const fixture = nativeCanvasFixture()
    vi.stubGlobal('createImageBitmap', undefined)
    const recipe = layerRecipe({ kind: 'text', text: 'a very long line\r\nsecond\nthird', color: '#abcdef', fontSize: 20, fontFamily: 'monospace', fontWeight: 700, align: 'right' })
    recipe.layers[0] = { ...recipe.layers[0], width: 0.5, height: 0.5, flipX: true, rotation: 90, opacity: 0.5, blend: 'multiply', adjustments: { brightness: 1.5, contrast: 0.5, saturation: 2, blur: 3, grayscale: 0.25 } }
    expect(await processBrowserImageTransform({ sources: [], recipe })).toMatchObject([{ width: 100, height: 80 }])
    expect(fixture.decode).not.toHaveBeenCalled()
    expect(fixture.canvases).toHaveLength(2)
    const [output, content] = fixture.canvases
    expect(content.calls.slice(0, 7)).toEqual([['translate', 14, 14], ['translate', 25, 20], ['scale', -1, 1], ['rotate', Math.PI / 2], ['beginPath'], ['rect', -25, -20, 50, 40], ['clip']])
    expect(content.calls.filter(([name]) => name === 'fillText')).toEqual([
      ['fillText', 'a very long line', 25, 0, { font: '700 20px monospace', baseline: 'alphabetic', align: 'right' }],
      ['fillText', 'second', 25, 24, { font: '700 20px monospace', baseline: 'alphabetic', align: 'right' }],
    ])
    expect(output.calls.find(([name]) => name === 'drawImage')?.at(-1)).toEqual({ alpha: 0.5, blend: 'multiply', filter: 'brightness(1.5) contrast(0.5) saturate(2) blur(3px) grayscale(0.25)' })
    expect(output.calls.filter(([name]) => name === 'drawImage')).toHaveLength(1)
    expect(fixture.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it.each(['left', 'center', 'right'] as const)('anchors %s aligned text in output pixels', async (align) => {
    const fixture = nativeCanvasFixture()
    await processBrowserImageTransform({ sources: [], recipe: layerRecipe({ kind: 'text', text: 'line', color: '#000000', fontSize: 10, fontFamily: 'sans-serif', fontWeight: 400, align }) })
    expect(fixture.canvases[1].calls.find(([name]) => name === 'fillText')?.slice(1, 4)).toEqual(['line', align === 'left' ? -50 : align === 'right' ? 50 : 0, -30])
  })

  it.each(['rectangle', 'ellipse'] as const)('renders a %s with an inward stroke and composites its fill and stroke once', async (shape) => {
    const fixture = nativeCanvasFixture()
    const recipe = layerRecipe({ kind: 'shape', shape, fill: '#11223380', stroke: '#ffffff', strokeWidth: 10 })
    recipe.layers[0].opacity = 0.3
    await processBrowserImageTransform({ sources: [], recipe })
    const [output, content] = fixture.canvases
    expect(content.calls.filter(([name]) => name === (shape === 'ellipse' ? 'ellipse' : 'rect'))).toEqual(shape === 'ellipse'
      ? [['ellipse', 0, 0, 50, 40, 0, 0, Math.PI * 2], ['ellipse', 0, 0, 45, 35, 0, 0, Math.PI * 2]]
      : [['rect', -50, -40, 100, 80], ['rect', -45, -35, 90, 70]])
    expect(content.calls).toContainEqual(['stroke', '#ffffff', 10])
    expect(output.calls.filter(([name]) => name === 'drawImage')).toHaveLength(1)
    expect(output.calls.find(([name]) => name === 'drawImage')?.at(-1)).toMatchObject({ alpha: 0.3 })
  })

  it('keeps transparent fill absent and bounds a thick inward stroke to a small layer', async () => {
    const fixture = nativeCanvasFixture()
    const recipe = layerRecipe({ kind: 'shape', shape: 'rectangle', fill: 'transparent', stroke: '#ffffff', strokeWidth: 64 })
    recipe.layers[0].height = 0.1
    await processBrowserImageTransform({ sources: [], recipe })
    expect(fixture.canvases[1].calls).toContainEqual(['stroke', '#ffffff', 8])
    expect(fixture.canvases[1].calls.filter(([name]) => name === 'fill')).toEqual([])
    expect(fixture.canvases[1].calls).toContainEqual(['rect', -46, 0, 92, 0])
  })

  it.each(['png', 'pixels'] as const)('clips a bare cubic path with enlarged stroke to the same local bounds as its preview for %s', async (target) => {
    const fixture = nativeCanvasFixture()
    const recipe = layerRecipe({ kind: 'path', points: [[100, 100], [9900, 100], [5000, 9900]], handles: [{ out: [2000, 5000] }, { in: [8000, 5000] }, {}], fill: '#ff000080', stroke: '#ffffff', strokeWidth: 64, space: { width: 100, height: 80 } })
    recipe.layers[0] = { ...recipe.layers[0], rotation: 45, flipX: true, width: 0.5, height: 0.75, opacity: 0.5, blend: 'multiply' }
    if (target === 'png') await processBrowserImageTransform({ sources: [], recipe })
    else await sampleBrowserImageLayerPixels({ sources: [], recipe, source: 'composite' })
    const [output, content] = fixture.canvases
    expect(content.calls).toContainEqual(['rect', 0, 0, 50, 60])
    expect(content.calls.findIndex(([name]) => name === 'clip')).toBeLessThan(content.calls.findIndex(([name]) => name === 'bezierCurveTo'))
    expect(content.calls.filter(([name]) => name === 'stroke')).toEqual([['stroke', '#ffffff', 48]])
    expect(output.calls.filter(([name]) => name === 'drawImage')).toHaveLength(1)
    expect(output.calls.find(([name]) => name === 'drawImage')?.at(-1)).toMatchObject({ alpha: 0.5, blend: 'multiply' })
    expect(fixture.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it('applies bitmap filters and both flips while keeping neutral defaults on the original drawing path', async () => {
    const fixture = nativeCanvasFixture()
    const recipe = layerRecipe()
    recipe.layers[0] = { ...recipe.layers[0], flipX: true, flipY: true, adjustments: { brightness: 1.2, contrast: 1, saturation: 1, blur: 0, grayscale: 1 } }
    await processBrowserImageTransform({ sources: [png()], recipe })
    expect(fixture.canvases).toHaveLength(1)
    expect(fixture.canvases[0].calls).toContainEqual(['scale', -1, -1])
    expect(fixture.canvases[0].calls.find(([name]) => name === 'drawImage')?.at(-1)).toMatchObject({ filter: 'brightness(1.2) contrast(1) saturate(1) blur(0px) grayscale(1)' })
    const neutral = nativeCanvasFixture(false)
    recipe.layers[0].adjustments = { brightness: 1, contrast: 1, saturation: 1, blur: 0, grayscale: 0 }
    await expect(processBrowserImageTransform({ sources: [png()], recipe })).resolves.toHaveLength(1)
    expect(neutral.canvases).toHaveLength(1)
  })

  it('fails explicitly when requested filters are unsupported and releases the allocated surface', async () => {
    const fixture = nativeCanvasFixture(false)
    const recipe = layerRecipe({ kind: 'shape', shape: 'ellipse', fill: '#ffffff', stroke: 'transparent', strokeWidth: 0 })
    recipe.layers[0].adjustments = { brightness: 1, contrast: 1, saturation: 1, blur: 2, grayscale: 0 }
    await expect(processBrowserImageTransform({ sources: [], recipe })).rejects.toThrow('不支持图层滤镜')
    expect(fixture.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it('retains a bounded off-canvas blur halo before clipping to the final output', async () => {
    const fixture = nativeCanvasFixture()
    const recipe = layerRecipe({ kind: 'shape', shape: 'rectangle', fill: '#ff0000', stroke: 'transparent', strokeWidth: 0 })
    recipe.outputWidth = 4096
    recipe.outputHeight = 4096
    recipe.layers[0] = { ...recipe.layers[0], x: -0.5, width: 0.5, height: 4, adjustments: { brightness: 1, contrast: 1, saturation: 1, blur: 32, grayscale: 0 } }
    const result = await processBrowserImageTransform({ sources: [], recipe })
    expect(result).toMatchObject([{ width: 4096, height: 4096 }])
    const [output, content] = fixture.canvases
    expect(output.allocated).toEqual([4096, 4096])
    expect(content.allocated).toEqual([4356, 4356])
    expect(content.allocated[0] * content.allocated[1]).toBeLessThan(19_000_000)
    expect(content.calls[0]).toEqual(['translate', 130, 130])
    expect(output.calls.find(([name]) => name === 'drawImage')?.slice(2, 4)).toEqual([-130, -130])
    expect(fixture.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it('accepts twenty small owned inputs without relaxing bytes or pixel bounds and supports an explicit empty canvas', async () => {
    const context = fixture(Array.from({ length: 20 }, () => ({ width: 7, height: 5 })))
    await context.process({ sources: Array.from({ length: 20 }, () => png()), recipe: defaultImageTransformRecipe('layer') })
    expect(context.canvases[0].draws).toHaveLength(20)
    expect(context.bitmaps.every((bitmap) => bitmap.close.mock.calls.length === 1)).toBe(true)
    const empty = nativeCanvasFixture()
    const recipe = { ...layerRecipe(), layers: [], explicitLayers: true }
    await expect(processBrowserImageTransform({ sources: [], recipe })).resolves.toHaveLength(1)
    expect(empty.decode).not.toHaveBeenCalled()
    expect(empty.canvases[0].calls.filter(([name]) => name === 'drawImage')).toEqual([])
    await expect(processBrowserImageTransform({ sources: [], recipe: { ...recipe, explicitLayers: false } })).rejects.toThrow()
  })
})
