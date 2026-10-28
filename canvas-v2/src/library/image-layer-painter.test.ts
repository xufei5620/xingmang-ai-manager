import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageLayer, ImageLayerGradient, ImageLayerFilterStroke, ImageLayerOperation, ImageLayerOutline, ImageLayerSelection, ImageLayerStroke } from '../image-tools/recipe'
import { applyImageLayerFeatherMask, paintImageLayerLocal, paintImageLayerLocalAsync, paintImageLayerWorldPreview, paintImageLayerWorldPreviewAsync } from './image-layer-painter'
import { defaultImageLayerColorGrade } from '../image-tools/layer-color-grade'
import { liquifyOperationFixture } from '../lib/liquify.test-fixture'
import type { ImageLayerWholeFilterOperation } from '../image-tools/layer-whole-filter'
import { parseColorLutCube } from '../image-tools/layer-color-lut'
import type { ColorLutSelection } from '../image-tools/layer-color-lut-selection'
import { defaultImageLayerColorDetail } from '../image-tools/layer-color-detail'
import { rasterizeLayerColorGrade } from '../image-tools/layer-color-grade-raster'
import { defaultImageLayerColorPresence } from '../image-tools/layer-color-presence'

interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number }
interface RecordedCall { name: string; args: unknown[]; alpha: number; blend: string; filter: string; clips: number; matrix: Matrix }

function surface(width = 100, height = 80) {
  let matrix: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, clips = 0
  const calls: RecordedCall[] = []
  const states: Array<{ matrix: Matrix; clips: number; alpha: number; blend: string; filter: string }> = []
  const canvas = { width, height, allocated: [width, height], getContext() { canvas.allocated = [canvas.width, canvas.height]; return context } }
  function call(name: string, ...args: unknown[]) { calls.push({ name, args, alpha: context.globalAlpha, blend: context.globalCompositeOperation, filter: context.filter, clips, matrix: { ...matrix } }) }
  const context = {
    canvas, globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none', fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '', font: '', textBaseline: '', textAlign: '', readAlpha: (_x: number, _y: number) => 0,
    save() { states.push({ matrix: { ...matrix }, clips, alpha: context.globalAlpha, blend: context.globalCompositeOperation, filter: context.filter }) },
    restore() { const state = states.pop(); if (!state) throw new Error('unbalanced restore'); matrix = state.matrix; clips = state.clips; context.globalAlpha = state.alpha; context.globalCompositeOperation = state.blend; if ('filter' in context) context.filter = state.filter },
    transform(a: number, b: number, c: number, d: number, e: number, f: number) { const m = matrix; matrix = { a: m.a * a + m.c * b, b: m.b * a + m.d * b, c: m.a * c + m.c * d, d: m.b * c + m.d * d, e: m.a * e + m.c * f + m.e, f: m.b * e + m.d * f + m.f } },
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { matrix = { a, b, c, d, e, f } },
    translate(x: number, y: number) { context.transform(1, 0, 0, 1, x, y) },
    scale(x: number, y: number) { context.transform(x, 0, 0, y, 0, 0) },
    rotate(angle: number) { context.transform(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0) },
    getTransform() { return { ...matrix } },
    beginPath() { call('beginPath') }, rect(...args: number[]) { call('rect', ...args) }, ellipse(...args: number[]) { call('ellipse', ...args) }, arc(...args: number[]) { call('arc', ...args) },
    closePath() { call('closePath') }, bezierCurveTo(...args: number[]) { call('bezierCurveTo', ...args) },
    createLinearGradient(...args: number[]) { call('createLinearGradient', ...args); return { addColorStop(offset: number, color: string) { call('addColorStop', offset, color) } } },
    clip(rule?: string) { clips++; call('clip', rule) },
    moveTo(...args: number[]) { call('moveTo', ...args) }, lineTo(...args: number[]) { call('lineTo', ...args) },
    fill() { call('fill', context.fillStyle) }, stroke() { call('stroke', context.strokeStyle, context.lineWidth) },
    fillRect(...args: number[]) { call('fillRect', ...args, context.fillStyle) },
    clearRect(...args: number[]) { call('clearRect', ...args) },
    getImageData(x: number, y: number, width: number, height: number) { const data = new Uint8ClampedArray(width * height * 4); for (let index = 0; index < width * height; index++) data[index * 4 + 3] = context.readAlpha(x + index % width, y + Math.floor(index / width)); return { width, height, data } },
    createImageData(width: number, height: number) { return { width, height, data: new Uint8ClampedArray(width * height * 4) } },
    putImageData(value: ImageData, x: number, y: number) { call('putImageData', value, x, y) },
    drawImage(...args: unknown[]) { call('drawImage', ...args) }, fillText(...args: unknown[]) { call('fillText', ...args) },
  }
  return { canvas, context: context as unknown as CanvasRenderingContext2D, calls, states }
}

function stroke(mode: ImageLayerStroke['mode'] = 'paint'): ImageLayerStroke {
  return { mode, points: [[2500, 5000], [7500, 5000]], size: 10, hardness: 1, opacity: 0.5, color: '#ff0000', space: { width: 100, height: 80 } }
}

function layer(operations: ImageLayerOperation[]): Pick<ImageLayer, 'content' | 'edits' | 'mask'> { return { content: { kind: 'paint' }, edits: { version: 1, operations } } }
function feather(inverted = false): ImageLayerSelection { return { kind: 'rectangle', transform: [0.5, 0, 0, 1, 0.25, 0], inverted, feather: { radius: 5, space: { width: 100, height: 80 } } } }
function scratchFixture(readAlpha?: (x: number, y: number) => number) {
  const scratch: ReturnType<typeof surface>[] = []
  vi.stubGlobal('document', { createElement() { const item = surface(0, 0); if (readAlpha) Object.assign(item.context, { readAlpha }); scratch.push(item); return item.canvas } })
  return scratch
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('shared editable layer painter', () => {
  it.each([false, true])('reads immutable native presence pixels once and matches the shared raster with detail %s', async (withDetail) => {
    const width = 23, height = 37, target = surface(width, height), data = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => [at * 7 % 180 + 30, at * 3 % 170 + 30, at * 11 % 190 + 20, at % 13 ? 255 : 0]).flat()), before = data.slice()
    const presence = { ...defaultImageLayerColorPresence(), texture: 60, clarity: 40, dehaze: 30 }, detail = defaultImageLayerColorDetail()
    detail.luminance.amount = 70; detail.color.amount = 80; detail.sharpening.amount = 90
    const grade = { ...defaultImageLayerColorGrade(), exposure: .2, presence, ...(withDetail ? { detail } : {}), grain: 15 }, reads: number[][] = []
    target.context.getImageData = ((x: number, y: number, w: number, h: number) => { reads.push([x, y, w, h]); return { width: w, height: h, data: data.slice(y * width * 4, (y + h) * width * 4) } }) as typeof target.context.getImageData
    await paintImageLayerLocalAsync(target.context, { layer: { content: { kind: 'paint' }, colorGrade: grade }, width, height })
    const output = new Uint8ClampedArray(data.length), writes = target.calls.filter((call) => call.name === 'putImageData')
    for (const call of writes) { const image = call.args[0] as ImageData; output.set(image.data, Number(call.args[2]) * width * 4) }
    expect(reads).toEqual([[0, 0, width, height]]); expect(writes.every((call) => (call.args[0] as ImageData).height <= 4)).toBe(true)
    expect(output).toEqual(rasterizeLayerColorGrade({ data, width, height, grade })); expect(output).not.toEqual(data); expect(data).toEqual(before)
  })
  it('prepares presence without detail at native resolution before reduced previews and preserves the last frame on cancellation', async () => {
    const scratch = scratchFixture(() => 255), target = surface(20, 16), presence = { ...defaultImageLayerColorPresence(), clarity: 50, dehaze: -40 }
    const drawing: ImageLayer = { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, content: { kind: 'paint' }, colorGrade: { ...defaultImageLayerColorGrade(), presence } }
    await paintImageLayerWorldPreviewAsync(target.context, { layer: drawing, output: { width: 200, height: 160 } })
    const native = scratch.find((item) => item.canvas.allocated[0] === 200 && item.canvas.allocated[1] === 160)!
    expect(native).toBeDefined(); expect(native.calls.filter((call) => call.name === 'putImageData')).toHaveLength(40)
    expect(target.calls.filter((call) => call.name === 'drawImage')).toHaveLength(1)
    const cancelled = surface(20, 16), controller = new AbortController(), pending = paintImageLayerWorldPreviewAsync(cancelled.context, { layer: drawing, output: { width: 200, height: 160 }, signal: controller.signal })
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(cancelled.calls).toEqual([])
    expect(scratch.every((item) => item.canvas.width === 0 && item.canvas.height === 0)).toBe(true)
  })
  it('reads spatial detail from one immutable native surface and matches full-frame pixels across old strip seams', async () => {
    const width = 23, height = 37, target = surface(width, height), data = new Uint8ClampedArray(Array.from({ length: width * height }, (_, at) => [at % 23 < 12 ? 70 + at * 7 % 20 : 180 + at * 3 % 20, at * 11 % 150 + 30, at * 17 % 160 + 20, at % 7 ? 255 : 33]).flat()), before = data.slice(), detail = defaultImageLayerColorDetail()
    detail.luminance.amount = 80; detail.color.amount = 90; detail.sharpening.amount = 70
    const grade = { ...defaultImageLayerColorGrade(), exposure: .2, detail, grain: 15 }, reads: number[][] = []
    target.context.getImageData = ((x: number, y: number, w: number, h: number) => { reads.push([x, y, w, h]); return { width: w, height: h, data: data.slice(y * width * 4, (y + h) * width * 4) } }) as typeof target.context.getImageData
    await paintImageLayerLocalAsync(target.context, { layer: { content: { kind: 'paint' }, colorGrade: grade }, width, height })
    const output = new Uint8ClampedArray(data.length), writes = target.calls.filter((call) => call.name === 'putImageData')
    for (const call of writes) { const image = call.args[0] as ImageData; output.set(image.data, Number(call.args[2]) * width * 4) }
    expect(reads).toEqual([[0, 0, width, height]])
    expect(writes.every((call) => (call.args[0] as ImageData).height <= 4)).toBe(true)
    expect(output).toEqual(rasterizeLayerColorGrade({ data, width, height, grade }))
    expect(output).not.toEqual(data); expect(data).toEqual(before)
  })
  it('prepares spatial detail at full native resolution before reduced previews and discards a cancelled result', async () => {
    const scratch = scratchFixture(() => 255), target = surface(20, 16), detail = defaultImageLayerColorDetail(); detail.luminance.amount = 80
    const drawing: ImageLayer = { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, content: { kind: 'paint' }, colorGrade: { ...defaultImageLayerColorGrade(), detail } }
    await paintImageLayerWorldPreviewAsync(target.context, { layer: drawing, output: { width: 200, height: 160 } })
    const native = scratch.find((item) => item.canvas.allocated[0] === 200 && item.canvas.allocated[1] === 160)!
    expect(native).toBeDefined()
    expect(native.calls.filter((call) => call.name === 'putImageData')).toHaveLength(40)
    expect(target.calls.filter((call) => call.name === 'drawImage')).toHaveLength(1)
    const cancelled = surface(20, 16), controller = new AbortController(), pending = paintImageLayerWorldPreviewAsync(cancelled.context, { layer: drawing, output: { width: 200, height: 160 }, signal: controller.signal })
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled.calls).toEqual([])
    expect(scratch.every((item) => item.canvas.width === 0 && item.canvas.height === 0)).toBe(true)
  })
  it('threads a custom LUT through local and reduced world native recursion with real pixel writes', async () => {
    const table = parseColorLutCube('TITLE "Owned inverse"\nLUT_1D_SIZE 2\n1 1 1\n0 0 0'), lut: ColorLutSelection = { version: 1, enabled: true, strength: 100, source: { kind: 'asset', lutAssetId: 'a'.repeat(43), digest: 'b'.repeat(64), name: table.name, domainMin: [0, 0, 0], domainMax: [1, 1, 1] } }
    const drawing: ImageLayer = { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, content: { kind: 'paint' }, colorGrade: { ...defaultImageLayerColorGrade(), lut } }
    const local = surface(4, 4); Object.assign(local.context, { readAlpha: () => 255 })
    await paintImageLayerLocalAsync(local.context, { layer: drawing, width: 4, height: 4, lutTable: table })
    const written = local.calls.find((call) => call.name === 'putImageData')!.args[0] as ImageData
    expect([...written.data]).toEqual(Array.from({ length: 16 }, () => [255, 255, 255, 255]).flat())
    const scratch = scratchFixture(() => 255), reduced = surface(2, 2)
    await paintImageLayerWorldPreviewAsync(reduced.context, { layer: drawing, output: { width: 4, height: 4 }, lutTable: table })
    const native = scratch.find((item) => item.calls.some((call) => call.name === 'putImageData'))!
    expect(native.canvas.allocated).toEqual([4, 4])
    expect([...(native.calls.find((call) => call.name === 'putImageData')!.args[0] as ImageData).data]).toEqual(Array.from({ length: 16 }, () => [255, 255, 255, 255]).flat())
    expect(reduced.calls.filter((call) => call.name === 'drawImage')).toHaveLength(1)
    expect(scratch.every((item) => item.canvas.width === 0 && item.canvas.height === 0)).toBe(true)
    const missing = surface(2, 2)
    await expect(paintImageLayerWorldPreviewAsync(missing.context, { layer: drawing, output: { width: 4, height: 4 } })).rejects.toThrow(/LUT.*尚未准备/)
    expect(missing.calls.filter((call) => call.name === 'drawImage')).toHaveLength(0)
  })

  it.each([false, true])('runs a whole filter between paint operations then applies one static mask (inverted %s)', async (inverted) => {
    const scratch = scratchFixture(() => 255), target = surface(64, 48)
    const operation: ImageLayerWholeFilterOperation = { mode: 'whole-filter', version: 1, filter: { type: 'mosaic', parameters: { size: 8 } }, space: { width: 64, height: 48 } }
    const before = { ...stroke(), color: '#ff0000' }, after = { ...stroke(), color: '#0000ff' }
    const mask: ImageLayerSelection = { kind: 'rectangle', transform: [.5, 0, 0, 1, .25, 0], inverted }
    await paintImageLayerLocalAsync(target.context, { layer: { ...layer([before, operation, after]), mask }, width: 64, height: 48 })
    const native = scratch[0], writes = native.calls.filter((call) => call.name === 'putImageData'), masks = native.calls.filter((call) => call.name === 'fill' && call.blend === (inverted ? 'destination-out' : 'destination-in')), strokes = native.calls.filter((call) => call.name === 'stroke')
    expect(native.canvas.allocated).toEqual([68, 52])
    expect(writes).toHaveLength(1); expect(masks).toHaveLength(1)
    expect(strokes.map((call) => call.args[0])).toEqual(['#ff0000', '#0000ff'])
    expect(native.calls.indexOf(strokes[0])).toBeLessThan(native.calls.indexOf(writes[0]))
    expect(native.calls.indexOf(writes[0])).toBeLessThan(native.calls.indexOf(strokes[1]))
    expect(native.calls.indexOf(strokes[1])).toBeLessThan(native.calls.indexOf(masks[0]))
    expect(masks[0]).toMatchObject({ alpha: 1, filter: 'none', matrix: { a: 32, d: 48, e: 18, f: 2 }, clips: 1 })
    expect(target.calls.filter((call) => call.name === 'drawImage')).toMatchObject([{ args: [native.canvas, 0, 0, 68, 52, -2, -2, 68, 52] }])
    expect(scratch.every((item) => item.canvas.width === 0 && item.canvas.height === 0)).toBe(true)
  })

  it('retains the complete native layer outside a small document and preserves prior world axes', async () => {
    const scratch = scratchFixture(() => 255), target = surface(80, 60)
    target.context.setTransform(0, .25, -.25, 0, -20, 30)
    const operation: ImageLayerWholeFilterOperation = { mode: 'whole-filter', version: 1, filter: { type: 'mosaic', parameters: { size: 8 } }, space: { width: 640, height: 480 } }
    await paintImageLayerLocalAsync(target.context, { layer: layer([stroke(), operation]), width: 640, height: 480, filterRaster: { width: 320, height: 240, scaleX: .25, scaleY: .25, offsetX: 0, offsetY: 0 } })
    const native = scratch[0], painted = native.calls.find((call) => call.name === 'stroke')!
    expect(native.canvas.allocated).toEqual([484, 644])
    // Original world rotation is retained; only the scratch origin is shifted.
    expect(painted.matrix).toMatchObject({ a: 0, b: 6.4, c: -6, d: 0, e: 482, f: 2 })
    expect(native.calls.filter((call) => call.name === 'putImageData')).toHaveLength(1)
    expect(target.calls.filter((call) => call.name === 'drawImage')).toMatchObject([{ args: [native.canvas, 0, 0, 484, 644, -140.5, 29.5, 121, 161] }])
    expect(scratch.every((item) => item.canvas.width === 0 && item.canvas.height === 0)).toBe(true)
  })

  it('never publishes a cancelled whole filter or allocates a neutral filter surface', async () => {
    const scratch = scratchFixture(() => 255), target = surface(128, 96), controller = new AbortController()
    const operation: ImageLayerWholeFilterOperation = { mode: 'whole-filter', version: 1, filter: { type: 'gaussian', parameters: { radius: 2 } }, space: { width: 128, height: 96 } }
    const pending = paintImageLayerLocalAsync(target.context, { layer: layer([operation]), width: 128, height: 96, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(target.calls).toEqual([])
    expect(scratch.every((item) => item.canvas.width === 0 && item.canvas.height === 0)).toBe(true)
    const count = scratch.length, neutral = { ...operation, filter: { type: 'gaussian' as const, parameters: { radius: 0 } } }
    paintImageLayerLocal(target.context, { layer: layer([neutral]), width: 128, height: 96 })
    expect(scratch).toHaveLength(count)
    expect(target.calls.some((call) => call.name === 'putImageData' || call.name === 'drawImage')).toBe(false)
  })

  it.each([false, true])('replays liquify in order then applies the unchanged static mask once (inverted %s)', async (inverted) => {
    const scratch = scratchFixture(() => 255), target = surface(128, 96), operation = liquifyOperationFixture()
    const before = { ...stroke(), color: '#ff0000' }, after = { ...stroke(), color: '#0000ff' }
    const mask: ImageLayerSelection = { kind: 'rectangle', transform: [.5, 0, 0, 1, .25, 0], inverted }
    await paintImageLayerLocalAsync(target.context, { layer: { ...layer([before, operation, after]), mask }, width: 128, height: 96 })
    const native = scratch[0], writes = native.calls.filter((call) => call.name === 'putImageData'), masks = native.calls.filter((call) => call.name === 'fill' && call.blend === (inverted ? 'destination-out' : 'destination-in'))
    expect(writes).toHaveLength(1); expect(masks).toHaveLength(1)
    const strokes = native.calls.filter((call) => call.name === 'stroke')
    expect(strokes.map((call) => call.args[0])).toEqual(['#ff0000', '#0000ff'])
    expect(native.calls.indexOf(strokes[0])).toBeLessThan(native.calls.indexOf(writes[0]))
    expect(native.calls.indexOf(writes[0])).toBeLessThan(native.calls.indexOf(strokes[1]))
    expect(native.calls.indexOf(strokes[1])).toBeLessThan(native.calls.indexOf(masks[0]))
    expect(masks[0]).toMatchObject({ alpha: 1, filter: 'none', matrix: { a: 64, d: 96, e: 32, f: 0 }, clips: 1 })
    expect(target.calls.filter((call) => call.name === 'drawImage')).toHaveLength(1)
    expect(scratch.every((item) => item.canvas.width === 0 && item.canvas.height === 0)).toBe(true)
  })
  it('isolates a downscaled liquify preview at native resolution and never publishes a cancelled frame', async () => {
    const scratch = scratchFixture(() => 255), target = surface(32, 24), controller = new AbortController(), operation = liquifyOperationFixture()
    target.context.setTransform(.25, 0, 0, .25, 0, 0)
    const pending = paintImageLayerLocalAsync(target.context, { layer: layer([operation]), width: 128, height: 96, filterRaster: { width: 128, height: 96, scaleX: .25, scaleY: .25, offsetX: 0, offsetY: 0 }, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(target.calls).toEqual([])
    expect(scratch[0].canvas.allocated).toEqual([128, 96])
    expect(scratch.every((item) => item.canvas.width === 0 && item.canvas.height === 0)).toBe(true)
  })
  it('grades source-free layer pixels once while preserving per-pixel alpha', async () => {
    const target = surface(3, 2), grade = defaultImageLayerColorGrade()
    grade.curves.rgb = [{ x: 0, y: .5 }, { x: 1, y: .5 }]
    Object.assign(target.context, { readAlpha: (x: number) => [0, 127, 255][x] })
    await paintImageLayerLocalAsync(target.context, { layer: { content: { kind: 'paint' }, colorGrade: grade }, width: 3, height: 2 })
    const writes = target.calls.filter((call) => call.name === 'putImageData')
    expect(writes).toHaveLength(1)
    expect([...((writes[0].args[0] as ImageData).data)]).toEqual([0, 0, 0, 0, 128, 128, 128, 127, 128, 128, 128, 255, 0, 0, 0, 0, 128, 128, 128, 127, 128, 128, 128, 255])
    expect(target.states).toHaveLength(0)
  })

  it('bypasses raster adjustment work for an explicitly neutral grade', () => {
    const target = surface(3, 2)
    paintImageLayerLocal(target.context, { layer: { content: { kind: 'paint' }, colorGrade: defaultImageLayerColorGrade() }, width: 3, height: 2 })
    expect(target.calls.some((call) => call.name === 'putImageData')).toBe(false)
  })

  it('grades the original output resolution before publishing a small world preview', async () => {
    const scratch = scratchFixture(() => 255), target = surface(20, 16)
    const grade = { ...defaultImageLayerColorGrade(), grain: 40 }
    await paintImageLayerWorldPreviewAsync(target.context, { layer: { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: .5, blend: 'multiply', visible: true, content: { kind: 'paint' }, colorGrade: grade }, output: { width: 200, height: 160 } })
    const native = scratch.find((item) => item.canvas.allocated[0] === 200 && item.canvas.allocated[1] === 160)!
    expect(native).toBeDefined()
    expect(native.calls.filter((call) => call.name === 'putImageData')).toHaveLength(10)
    expect(target.calls.filter((call) => call.name === 'drawImage')).toHaveLength(1)
    expect(scratch.every((item) => item.canvas.width === 0 && item.canvas.height === 0)).toBe(true)
  })

  it('cancels a graded native preview between strips without publishing partial pixels', async () => {
    const scratch = scratchFixture(() => 255), target = surface(100, 80), controller = new AbortController()
    const pending = paintImageLayerWorldPreviewAsync(target.context, { layer: { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, content: { kind: 'paint' }, colorGrade: { ...defaultImageLayerColorGrade(), exposure: 1 } }, output: { width: 1000, height: 800 }, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(target.calls).toEqual([])
    expect(scratch.every((item) => item.canvas.width === 0 && item.canvas.height === 0)).toBe(true)
  })

  it('isolates a filter at original layer resolution and publishes only the complete frame', async () => {
    const scratch = scratchFixture(() => 255), target = surface(100, 80)
    target.context.setTransform(.1, 0, 0, .1, 0, 0)
    const filter: ImageLayerFilterStroke = { mode: 'blur', points: [[5000, 5000]], size: 30, strength: 1, space: { width: 1000, height: 800 } }
    await paintImageLayerLocalAsync(target.context, { layer: layer([filter]), width: 1000, height: 800, filterRaster: { width: 1000, height: 800, scaleX: .1, scaleY: .1, offsetX: 0, offsetY: 0 } })
    expect(scratch[0].canvas.allocated).toEqual([1000, 800])
    expect(target.calls.filter((call) => call.name === 'drawImage')).toMatchObject([{ args: [scratch[0].canvas, 0, 0, 1000, 800, 0, 0, 100, 80] }])
    expect(scratch[1].canvas.allocated[0]).toBeLessThan(40)
    expect(scratch[2].canvas.allocated[1]).toBeLessThan(100)
    expect(scratch.every(({ canvas }) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it('keeps filter strength independent of sample overlap and applies selection before pixel compositing', async () => {
    const scratch = scratchFixture(() => 255), target = surface()
    const filter: ImageLayerFilterStroke = { mode: 'sharpen', points: [[3000, 5000], [5000, 5000], [3000, 5000]], size: 30, strength: .7, space: { width: 100, height: 80 }, selection: feather(true) }
    await paintImageLayerLocalAsync(target.context, { layer: { ...layer([filter]), mask: { kind: 'rectangle', transform: [.5, 0, 0, 1, 0, 0], inverted: false } }, width: 100, height: 80 })
    const masks = scratch.filter(({ calls }) => calls.some((call) => call.name === 'stroke'))
    expect(masks.length).toBeGreaterThan(0)
    expect(masks.every(({ calls }) => calls.some((call) => call.name === 'stroke' && call.alpha === 1))).toBe(true)
    expect(masks.every(({ calls }) => calls.some((call) => call.name === 'fill' && call.blend === 'destination-out'))).toBe(true)
    expect(target.calls.filter((call) => call.name === 'drawImage')).toHaveLength(1)
  })

  it('cancels a 4K filter between strips without touching the destination or retaining surfaces', async () => {
    const scratch = scratchFixture(() => 255), target = surface(3840, 2160), controller = new AbortController()
    const filter: ImageLayerFilterStroke = { mode: 'blur', points: [[1000, 1000], [9000, 9000]], size: 121, strength: 1, space: { width: 3840, height: 2160 } }
    const pending = paintImageLayerLocalAsync(target.context, { layer: layer([filter]), width: 3840, height: 2160, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(target.calls).toEqual([])
    expect(scratch[0].canvas.allocated).toEqual([3840, 2160])
    expect(scratch.every(({ canvas }) => canvas.width === 0 && canvas.height === 0)).toBe(true)
    expect(scratch.slice(2).every(({ canvas }) => canvas.allocated[1] <= 96)).toBe(true)
  })

  it('draws linear gradients in transformed layer coordinates with stop alpha and one operation opacity', () => {
    const target = surface(), selection: ImageLayerSelection = { kind: 'ellipse', transform: [0.5, 0, 0, 1, 0.25, 0], inverted: true }
    target.context.translate(20, 30); target.context.rotate(Math.PI / 4); target.context.scale(-2, 0.5)
    const gradient: ImageLayerGradient = { mode: 'gradient', from: [1000, 2000], to: [9000, 8000], startColor: '#ff000080', endColor: '#0000ff00', opacity: 0.4, space: { width: 100, height: 80 }, selection }
    paintImageLayerLocal(target.context, { layer: layer([gradient]), width: 100, height: 80 })
    expect(target.calls.filter((call) => call.name === 'createLinearGradient')).toMatchObject([{ args: [10, 16, 90, 64] }])
    expect(target.calls.filter((call) => call.name === 'addColorStop').map((call) => call.args)).toEqual([[0, '#ff000080'], [1, '#0000ff00']])
    expect(target.calls.filter((call) => call.name === 'fillRect')).toMatchObject([{ alpha: 0.4, clips: 2, blend: 'source-over' }])
    expect(target.calls.filter((call) => call.name === 'clip').at(-1)?.args).toEqual(['evenodd'])
    expect(target.states).toHaveLength(0)
  })

  it('applies a gradient feather selection once on scratch and then the permanent mask once on the layer', () => {
    const scratch = scratchFixture(), target = surface()
    const gradient: ImageLayerGradient = { mode: 'gradient', from: [0, 0], to: [10000, 0], startColor: '#ff000080', endColor: '#0000ffff', opacity: 0.5, space: { width: 100, height: 80 }, selection: feather() }
    paintImageLayerLocal(target.context, { layer: { ...layer([gradient]), mask: feather(true) }, width: 100, height: 80 })
    expect(scratch[0].calls.filter((call) => call.name === 'fillRect')).toMatchObject([{ alpha: 1, filter: 'none' }])
    expect(scratch[0].calls.filter((call) => call.name === 'fill')).toMatchObject([{ blend: 'destination-in', filter: 'blur(5px)' }])
    expect(target.calls.filter((call) => call.name === 'drawImage')).toMatchObject([{ alpha: 0.5, blend: 'source-over' }])
    expect(target.calls.filter((call) => call.name === 'fill')).toMatchObject([{ blend: 'destination-out', alpha: 1 }])
    expect(scratch[0].canvas.width).toBe(0); expect(scratch[0].canvas.height).toBe(0)
  })

  it('draws bounded cubic segments including the closing handles before subsequent editable erasure', () => {
    const target = surface()
    paintImageLayerLocal(target.context, { layer: { content: { kind: 'path', points: [[0, 0], [10000, 0], [5000, 10000]], handles: [{ in: [1000, 2000], out: [3000, 5000] }, { in: [7000, 5000] }, { out: [2000, 8000] }], fill: '#ffaa5580', stroke: '#ffffff', strokeWidth: 2, space: { width: 50, height: 40 } }, edits: { version: 1, operations: [stroke('erase')] } }, width: 100, height: 80 })
    expect(target.calls.filter((call) => call.name === 'bezierCurveTo').map((call) => call.args)).toEqual([[-20, 0, 20, 0, 50, -40], [-30, 24, -40, -24, -50, -40]])
    expect(target.calls.filter((call) => call.name === 'closePath')).toHaveLength(1)
    expect(target.calls.filter((call) => call.name === 'stroke')).toMatchObject([{ args: ['#ffffff', 4], blend: 'source-over' }, { blend: 'destination-out' }])
    expect(target.states).toHaveLength(0)
  })

  it('rejects unsupported gradient feathering without leaking surfaces or partially compositing the operation', () => {
    const target = surface(), scratch = surface(0, 0)
    Reflect.deleteProperty(scratch.context, 'filter')
    vi.stubGlobal('document', { createElement: () => scratch.canvas })
    const gradient: ImageLayerGradient = { mode: 'gradient', from: [0, 0], to: [10000, 0], startColor: '#ffffff', endColor: '#000000', opacity: 1, space: { width: 100, height: 80 }, selection: feather() }
    expect(() => paintImageLayerLocal(target.context, { layer: layer([gradient]), width: 100, height: 80 })).toThrow('不支持选区羽化')
    expect('filter' in scratch.context).toBe(false)
    expect(scratch.canvas.width).toBe(0); expect(scratch.canvas.height).toBe(0)
    expect(target.calls.some((call) => call.name === 'drawImage')).toBe(false)
    expect(target.states).toHaveLength(0)
  })
  it('uses output-axis kernel coordinates for rotated flipped previews and applies filters once without baking SVG opacity or blend', () => {
    const scratch = scratchFixture(), target = surface(200, 100)
    const source: ImageLayer = { sourceIndex: 0, x: 0.1, y: 0.2, width: 0.6, height: 1.4, rotation: 45, flipX: true, flipY: true, opacity: 0.4, blend: 'multiply', visible: true, content: { kind: 'paint' }, adjustments: { brightness: 1.2, contrast: 0.8, saturation: 1.1, blur: 4, grayscale: 0.2 }, edits: { version: 1, operations: [stroke()] } }
    paintImageLayerWorldPreview(target.context, { layer: source, output: { width: 400, height: 200 } })
    expect(scratch[0].canvas.allocated).toEqual([220, 120])
    const painted = scratch[0].calls.find((call) => call.name === 'stroke')!
    const angle = Math.PI / 4, localX = 25, localY = 30
    const result = { x: painted.matrix.a * localX + painted.matrix.c * localY + painted.matrix.e, y: painted.matrix.b * localX + painted.matrix.d * localY + painted.matrix.f }
    const localScaledX = localX * 240 / 100, localScaledY = localY * 280 / 80
    expect(result.x).toBeCloseTo(10 + 0.5 * (160 - (Math.cos(angle) * (localScaledX - 120) - Math.sin(angle) * (localScaledY - 140))))
    expect(result.y).toBeCloseTo(10 + 0.5 * (180 - (Math.sin(angle) * (localScaledX - 120) + Math.cos(angle) * (localScaledY - 140))))
    expect(target.calls.filter((call) => call.name === 'drawImage')).toMatchObject([{ alpha: 1, blend: 'source-over', filter: 'brightness(1.2) contrast(0.8) saturate(1.1) blur(2px) grayscale(0.2)' }])
    expect(scratch[0].calls.filter((call) => call.name === 'stroke')).toMatchObject([{ alpha: 0.5, filter: 'none' }])
    expect(scratch[0].canvas.width).toBe(0)
    expect(target.states).toHaveLength(0)
  })

  it('bounds preview halo allocations independently from huge logical layers and releases cancelled surfaces', () => {
    const scratch = scratchFixture(), target = surface(1024, 1024), source: ImageLayer = { sourceIndex: 0, x: 0, y: 0, width: 4, height: 4, rotation: 45, opacity: 1, blend: 'source-over', visible: true, content: { kind: 'paint' }, adjustments: { brightness: 1, contrast: 1, saturation: 1, blur: 32, grayscale: 0 } }
    paintImageLayerWorldPreview(target.context, { layer: source, output: { width: 4096, height: 4096 } })
    expect(scratch[0].canvas.allocated).toEqual([1092, 1092])
    expect(scratch[0].canvas.width).toBe(0)
    paintImageLayerWorldPreview(target.context, { layer: source, output: { width: 1024, height: 1024 } })
    expect(scratch[1].canvas.allocated).toEqual([1284, 1284])
    expect(() => paintImageLayerWorldPreview(surface(1025, 1024).context, { layer: source, output: { width: 4096, height: 4096 } })).toThrow('安全容量')
    const controller = new AbortController(); controller.abort()
    expect(() => paintImageLayerWorldPreview(target.context, { layer: source, output: { width: 4096, height: 4096 }, signal: controller.signal })).toThrow('取消')
    expect(scratch.every((value) => value.canvas.width === 0 && value.canvas.height === 0)).toBe(true)
  })
  it('keeps asynchronous world previews identical to the synchronous geometry, transient stroke and filtered final composite', async () => {
    const scratch = scratchFixture(), target = surface(200, 100), asynchronous = surface(200, 100)
    const source: ImageLayer = { sourceIndex: 0, x: .1, y: .2, width: .6, height: 1.4, rotation: 45, flipX: true, opacity: .4, blend: 'multiply', visible: true, content: { kind: 'paint' }, adjustments: { brightness: 1.2, contrast: .8, saturation: 1.1, blur: 4, grayscale: .2 }, edits: { version: 1, operations: [stroke()] } }
    const input = { layer: source, output: { width: 400, height: 200 }, transient: stroke('erase') }
    paintImageLayerWorldPreview(target.context, input)
    await paintImageLayerWorldPreviewAsync(asynchronous.context, input)
    expect(scratch[1].calls).toEqual(scratch[0].calls)
    expect(asynchronous.calls.map(({ args, ...call }) => ({ ...call, args: call.name === 'drawImage' ? args.slice(1) : args }))).toEqual(target.calls.map(({ args, ...call }) => ({ ...call, args: call.name === 'drawImage' ? args.slice(1) : args })))
    expect(scratch.every((value) => value.canvas.width === 0 && value.canvas.height === 0)).toBe(true)
    expect(asynchronous.states).toHaveLength(0)
  })
  it('cancels yielded world previews without clearing or compositing the previous complete frame', async () => {
    const scratch = scratchFixture(), target = surface(200, 100), controller = new AbortController()
    const source: ImageLayer = { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, content: { kind: 'paint' }, edits: { version: 1, operations: Array.from({ length: 8 }, () => stroke()) } }
    const pending = paintImageLayerWorldPreviewAsync(target.context, { layer: source, output: { width: 400, height: 200 }, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(target.calls).toEqual([])
    expect(scratch.every((value) => value.canvas.width === 0 && value.canvas.height === 0 && value.states.length === 0)).toBe(true)
    const before = scratch.length
    await expect(paintImageLayerWorldPreviewAsync(target.context, { layer: source, output: { width: 400, height: 200 }, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(paintImageLayerWorldPreviewAsync(target.context, { layer: source, output: { width: 400, height: 200 }, deadline: Date.now() - 1 })).rejects.toThrow('超时')
    expect(scratch).toHaveLength(before)
  })
  it('uses raster row coverage for hard clipping and a single feather mask without expanding to its bounding rectangle', () => {
    const target = surface(), selection: ImageLayerSelection = { kind: 'raster', transform: [0.5, 0, 0, 1, 0.25, 0], inverted: true, raster: { width: 4, height: 2, runs: [0, 2, 5, 1] } }
    paintImageLayerLocal(target.context, { layer: layer([{ mode: 'fill', color: '#ff0000', opacity: 1, selection }]), width: 100, height: 80 })
    expect(target.calls.filter((call) => call.name === 'rect').map((call) => call.args)).toEqual([[0, 0, 100, 80], [0, 0, 100, 80], [0, 0, 0.5, 0.5], [0.25, 0.5, 0.25, 0.5]])
    expect(target.calls.filter((call) => call.name === 'clip').at(-1)?.args).toEqual(['evenodd'])
    applyImageLayerFeatherMask(target.context, { mask: { ...selection, feather: { radius: 3, space: { width: 100, height: 80 } } }, width: 100, height: 80 })
    expect(target.calls.filter((call) => call.name === 'fill')).toMatchObject([{ blend: 'destination-out', filter: 'blur(3px)', alpha: 1 }])
  })

  it('keeps empty feather masks empty and their complements full without relying on a browser empty-path composite', () => {
    const target = surface(), mask: ImageLayerSelection = { kind: 'raster', transform: [1, 0, 0, 1, 0, 0], inverted: false, raster: { width: 4, height: 2, runs: [] }, feather: { radius: 3, space: { width: 100, height: 80 } } }
    applyImageLayerFeatherMask(target.context, { mask, width: 100, height: 80 })
    expect(target.calls.filter((call) => call.name === 'clearRect')).toMatchObject([{ args: [0, 0, 100, 80], matrix: { a: 1, d: 1, e: 0, f: 0 } }])
    applyImageLayerFeatherMask(target.context, { mask: { ...mask, inverted: true }, width: 100, height: 80 })
    expect(target.calls.filter((call) => call.name === 'clearRect')).toHaveLength(1)
    expect(target.states).toHaveLength(0)
  })

  it('derives an outside alpha outline then composites its color and opacity only once', () => {
    const scratch = scratchFixture((x, y) => x >= 24 && x < 44 && y >= 24 && y < 44 ? 255 : 0), target = surface()
    const operation: ImageLayerOutline = { mode: 'outline', color: '#ff660080', opacity: 0.4, width: 2, position: 'outside', space: { width: 100, height: 80 }, selection: { kind: 'rectangle', transform: [0.2, 0, 0, 0.25, 0.2, 0.25], inverted: false } }
    paintImageLayerLocal(target.context, { layer: layer([operation]), width: 100, height: 80 })
    const pixels = scratch[0].calls.find((call) => call.name === 'putImageData')?.args[0] as ImageData
    expect(Array.from(pixels.data.slice((30 * pixels.width + 22) * 4, (30 * pixels.width + 22) * 4 + 4))).toEqual([255, 102, 0, 128])
    expect(pixels.data[(30 * pixels.width + 24) * 4 + 3]).toBe(0)
    expect(target.calls.filter((call) => call.name === 'drawImage')).toMatchObject([{ alpha: 0.4, blend: 'source-over', args: [expect.anything(), 4, 4, 100, 80, 0, 0, 100, 80] }])
    expect(scratch[0].canvas.width).toBe(0)
    expect(target.states).toHaveLength(0)
  })

  it('pads and bands outlines so viewport and band edges never become synthetic selection borders', () => {
    const scratch = scratchFixture(() => 255), target = surface(100, 600)
    const operation: ImageLayerOutline = { mode: 'outline', color: '#ffffff', opacity: 1, width: 5, position: 'inside', space: { width: 100, height: 600 }, selection: { kind: 'rectangle', transform: [10, 0, 0, 10, -4, -4], inverted: false } }
    paintImageLayerLocal(target.context, { layer: layer([operation]), width: 100, height: 600 })
    expect(target.calls.filter((call) => call.name === 'drawImage').map((call) => call.args.slice(1))).toEqual([[7, 7, 100, 256, 0, 0, 100, 256], [7, 7, 100, 256, 0, 256, 100, 256], [7, 7, 100, 88, 0, 512, 100, 88]])
    for (const call of scratch[0].calls.filter((call) => call.name === 'putImageData')) {
      const pixels = call.args[0] as ImageData
      for (let y = 7; y < pixels.height - 7; y++) for (let x = 7; x < pixels.width - 7; x++) expect(pixels.data[(y * pixels.width + x) * 4 + 3]).toBe(0)
    }
    expect(scratch).toHaveLength(1)
    expect(scratch[0].canvas.width).toBe(0)
  })

  it('interrupts outline work within a band and releases the shared scratch surface', async () => {
    const scratch = scratchFixture(() => 255), target = surface(1024, 768), controller = new AbortController()
    const operation: ImageLayerOutline = { mode: 'outline', color: '#ffffff', opacity: 1, width: 2, position: 'center', space: { width: 1024, height: 768 }, selection: { kind: 'rectangle', transform: [1, 0, 0, 1, 0, 0], inverted: false } }
    setTimeout(() => controller.abort(), 0)
    await expect(paintImageLayerLocalAsync(target.context, { layer: layer([operation]), width: 1024, height: 768, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(target.calls.some((call) => call.name === 'drawImage')).toBe(false)
    expect(scratch[0].canvas.width).toBe(0)
    expect(target.states).toHaveLength(0)
  })

  it('rejects feathered outlines without native filter support before assigning an expando and releases scratch', () => {
    const target = surface(), scratch = surface(0, 0)
    Reflect.deleteProperty(scratch.context, 'filter')
    vi.stubGlobal('document', { createElement: () => scratch.canvas })
    const operation: ImageLayerOutline = { mode: 'outline', color: '#ffffff', opacity: 1, width: 2, position: 'center', space: { width: 100, height: 80 }, selection: feather() }
    expect(() => paintImageLayerLocal(target.context, { layer: layer([operation]), width: 100, height: 80 })).toThrow('当前浏览器不支持选区羽化')
    expect('filter' in scratch.context).toBe(false)
    expect(scratch.canvas.width).toBe(0)
    expect(scratch.canvas.height).toBe(0)
    expect(target.states).toHaveLength(0)
    expect(target.calls.some((call) => call.name === 'drawImage')).toBe(false)
  })

  it('does not manufacture filter support on a neutral persistent preview before a later adjusted redraw', () => {
    const scratch = scratchFixture(), target = surface(), source: ImageLayer = { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, content: { kind: 'paint' } }
    Reflect.deleteProperty(target.context, 'filter')
    paintImageLayerWorldPreview(target.context, { layer: source, output: { width: 100, height: 80 } })
    expect('filter' in target.context).toBe(false)
    expect(() => paintImageLayerWorldPreview(target.context, { layer: { ...source, adjustments: { brightness: 1.5, contrast: 1, saturation: 1, blur: 0, grayscale: 0 } }, output: { width: 100, height: 80 } })).toThrow('不支持图层滤镜')
    expect('filter' in target.context).toBe(false)
    expect(scratch.every((value) => value.canvas.width === 0 && value.canvas.height === 0)).toBe(true)
    expect(target.states).toHaveLength(0)
  })

  it('rejects feather fills before they can manufacture filter support on the reused scratch context', () => {
    const target = surface(), scratch = surface(0, 0)
    Reflect.deleteProperty(scratch.context, 'filter')
    vi.stubGlobal('document', { createElement: () => scratch.canvas })
    expect(() => paintImageLayerLocal(target.context, { layer: layer([{ mode: 'fill', color: '#ffffff', opacity: 1, selection: feather() }]), width: 100, height: 80 })).toThrow('不支持选区羽化')
    expect('filter' in scratch.context).toBe(false)
    expect(scratch.canvas.width).toBe(0)
    expect(target.states).toHaveLength(0)
  })
  it('fills the current layer or hard selection in ordered paint and erase history without rasterizing its source', () => {
    const target = surface(), selection = { ...feather(true), feather: undefined }
    paintImageLayerLocal(target.context, { layer: layer([{ mode: 'fill', color: '#aabbcc80', opacity: 0.4, selection }, stroke('erase'), { mode: 'fill', color: '#ffffff', opacity: 1 }]), width: 100, height: 80 })
    expect(target.calls.filter((call) => ['fillRect', 'stroke'].includes(call.name)).map((call) => [call.name, call.blend, call.alpha, call.clips])).toEqual([
      ['fillRect', 'source-over', 0.4, 2], ['stroke', 'destination-out', 0.5, 1], ['fillRect', 'source-over', 1, 1],
    ])
    expect(target.states).toHaveLength(0)
  })

  it('applies a feather layer mask once after all edits and can defer it for an unmasked preview cache', () => {
    const target = surface(), mask = feather(), input = { layer: { ...layer([stroke(), stroke()]), mask }, width: 100, height: 80 }
    paintImageLayerLocal(target.context, input)
    expect(target.calls.filter((call) => call.name === 'fill')).toMatchObject([{ blend: 'destination-in', alpha: 1, filter: 'blur(5px)', clips: 1 }])
    expect(target.calls.map((call) => call.name === 'stroke').lastIndexOf(true)).toBeLessThan(target.calls.findIndex((call) => call.name === 'fill'))
    const cached = surface()
    paintImageLayerLocal(cached.context, { ...input, deferFeatherMask: true })
    expect(cached.calls.some((call) => call.blend === 'destination-in')).toBe(false)
    applyImageLayerFeatherMask(cached.context, { mask, width: 100, height: 80 })
    expect(cached.calls.filter((call) => call.blend === 'destination-in' && call.name === 'fill')).toHaveLength(1)
  })

  it('masks each isolated feathered stroke or fill before merging and keeps erase coverage independent of color', () => {
    const scratch = scratchFixture(), target = surface()
    paintImageLayerLocal(target.context, { layer: layer([{ ...stroke('erase'), color: '#ff000000', selection: feather(true) }, { mode: 'fill', color: '#ff000080', opacity: 0.3, selection: feather() }]), width: 100, height: 80 })
    expect(scratch).toHaveLength(1)
    expect(scratch[0].calls.filter((call) => call.name === 'stroke')).toMatchObject([{ args: ['#000000', 10], alpha: 1, blend: 'source-over' }])
    expect(scratch[0].calls.filter((call) => call.name === 'fill').map((call) => [call.blend, call.filter])).toEqual([['destination-out', 'blur(5px)'], ['destination-in', 'blur(5px)']])
    expect(target.calls.filter((call) => call.name === 'drawImage').map((call) => [call.blend, call.alpha])).toEqual([['destination-out', 0.5], ['source-over', 0.3]])
    expect(scratch[0].canvas.width).toBe(0)
    expect(target.states).toHaveLength(0)
  })

  it('scales feather consistently for preview and resized layers and rejects extreme effective radii', () => {
    const target = surface()
    target.context.scale(0.5, 0.5)
    applyImageLayerFeatherMask(target.context, { mask: feather(), width: 200, height: 160 })
    expect(target.calls.find((call) => call.name === 'fill')?.filter).toBe('blur(5px)')
    expect(() => applyImageLayerFeatherMask(target.context, { mask: { ...feather(), feather: { radius: 128, space: { width: 0.001, height: 0.001 } } }, width: 100, height: 80 })).toThrow('缩放过大')
    expect(target.states).toHaveLength(0)
  })

  it('replays paint, erase and repaint in order on the isolated layer and applies opacity once per path', () => {
    const target = surface()
    const input = layer([stroke(), stroke('erase'), { ...stroke(), color: '#00ff00' }])
    paintImageLayerLocal(target.context, { layer: input, width: 100, height: 80 })
    expect(target.calls.filter((call) => call.name === 'stroke').map((call) => [call.blend, call.alpha, call.args[0]])).toEqual([
      ['source-over', 0.5, '#ff0000'], ['destination-out', 0.5, '#000000'], ['source-over', 0.5, '#00ff00'],
    ])
    expect(target.context.globalCompositeOperation).toBe('source-over')
    expect(target.states).toHaveLength(0)
  })

  it('keeps original text, shapes and bitmaps editable beneath ordered strokes', () => {
    const text = surface()
    paintImageLayerLocal(text.context, { layer: { ...layer([stroke('erase')]), content: { kind: 'text', text: 'Title', color: '#ffffff', fontSize: 20, fontFamily: 'serif', fontWeight: 400, align: 'left' } }, width: 100, height: 80 })
    expect(text.calls.findIndex((call) => call.name === 'fillText')).toBeLessThan(text.calls.findIndex((call) => call.name === 'stroke'))
    const bitmap = surface(), source = {} as CanvasImageSource
    paintImageLayerLocal(bitmap.context, { layer: { edits: { version: 1, operations: [stroke('erase')] } }, source, width: 100, height: 80 })
    expect(bitmap.calls.find((call) => call.name === 'drawImage')).toMatchObject({ args: [source, 0, 0, 100, 80], blend: 'source-over', alpha: 1 })
    expect(bitmap.calls.find((call) => call.name === 'stroke')?.blend).toBe('destination-out')
  })

  it('clips soft pixels after blur and composes each stroke only once within both mask and selection', () => {
    const scratch = scratchFixture(), target = surface()
    const operation = { ...stroke(), hardness: 0, selection: { kind: 'ellipse' as const, transform: [0.5, 0, 0, 1, 0.25, 0] as [number, number, number, number, number, number], inverted: true } }
    paintImageLayerLocal(target.context, { layer: { ...layer([operation, { ...operation, mode: 'erase' }]), mask: { kind: 'rectangle', transform: [1, 0, 0, 1, 0, 0], inverted: false } }, width: 100, height: 80 })
    expect(scratch).toHaveLength(1)
    const composites = target.calls.filter((call) => call.name === 'drawImage')
    expect(composites.map((call) => [call.blend, call.clips, call.alpha, call.filter])).toEqual([['source-over', 3, 0.5, 'none'], ['destination-out', 3, 0.5, 'none']])
    expect(target.calls.filter((call) => call.name === 'clip').map((call) => call.args[0])).toEqual([undefined, 'nonzero', 'evenodd', 'evenodd'])
    expect(scratch[0].calls.filter((call) => call.name === 'stroke').every((call) => call.filter.startsWith('blur(') && call.alpha === 1 && call.clips === 0)).toBe(true)
    expect(scratch[0].canvas.width).toBe(0)
    expect(scratch[0].canvas.height).toBe(0)
    expect(target.states).toHaveLength(0)
  })

  it('uses bounded visible brush rectangles and reuses one scratch rather than allocating logical layer dimensions', () => {
    const scratch = scratchFixture(), target = surface(4096, 4096)
    const operation = { ...stroke(), hardness: 0.5, points: [[0, 0]] as Array<[number, number]>, space: { width: 16384, height: 16384 } }
    paintImageLayerLocal(target.context, { layer: layer([operation, operation]), width: 16384, height: 16384 })
    expect(scratch).toHaveLength(1)
    expect(scratch[0].canvas.allocated[0]).toBeLessThan(20)
    expect(scratch[0].canvas.allocated[1]).toBeLessThan(20)
    expect(scratch[0].calls.filter((call) => call.name === 'arc')).toHaveLength(2)
    expect(() => paintImageLayerLocal(surface(5000, 5000).context, { layer: layer([]), width: 100, height: 100 })).toThrow('安全容量')
    expect(() => paintImageLayerLocal(target.context, { layer: layer([{ ...operation, space: { width: 0.001, height: 0.001 } }]), width: 16384, height: 16384 })).toThrow('缩放过大')
  })

  it('drops fully off-canvas soft strokes without allocating scratch and never clamps their points to the edge', () => {
    const scratch = scratchFixture(), target = surface()
    paintImageLayerLocal(target.context, { layer: layer([{ ...stroke(), hardness: 0.5, points: [[-20000, -20000], [-10000, -10000]] }]), width: 100, height: 80 })
    expect(scratch).toHaveLength(0)
    expect(target.calls.some((call) => call.name === 'drawImage' || call.name === 'stroke')).toBe(false)
  })

  it('yields during long replay so cancellation stops before later strokes and releases scratch', async () => {
    const scratch = scratchFixture(), target = surface(), controller = new AbortController()
    setTimeout(() => controller.abort(), 0)
    await expect(paintImageLayerLocalAsync(target.context, { layer: layer(Array.from({ length: 256 }, () => ({ ...stroke(), hardness: 0.5 }))), width: 100, height: 80, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(target.calls.filter((call) => call.name === 'drawImage')).toHaveLength(4)
    expect(scratch[0].canvas.width).toBe(0)
    expect(target.states).toHaveLength(0)
  })

  it('checks the deadline inside the stroke loop and restores caller state on failure', () => {
    const target = surface()
    let time = 0
    vi.spyOn(Date, 'now').mockImplementation(() => time++)
    expect(() => paintImageLayerLocal(target.context, { layer: layer(Array.from({ length: 10 }, () => stroke())), width: 100, height: 80, deadline: 3 })).toThrow('等待超时')
    expect(target.calls.filter((call) => call.name === 'stroke')).toHaveLength(2)
    expect(target.states).toHaveLength(0)
  })
})
