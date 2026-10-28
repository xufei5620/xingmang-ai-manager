import { inflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildEditorLayerMergePlan } from '../image-tools/layer-editor-merge'
import { createLayerEditorState, defaultEditorImageLayer, selectEditorLayer } from '../image-tools/layer-editor-state'
import type { ImageLayerRecipe } from '../image-tools/recipe'
import { defaultImageLayerColorGrade } from '../image-tools/layer-color-grade'
import { parseColorLutCube } from '../image-tools/layer-color-lut'
import { colorLutSourceKey, type ColorLutSelection } from '../image-tools/layer-color-lut-selection'
import { snapshotLayerColorLutTables } from '../image-tools/layer-color-lut-runtime'
import { encodeImportedPsdLayerPng } from './browser-layer-psd-import'
import { compareEditorLayerMergePixels, createBrowserEditorLayerMergeReviewer, type BrowserEditorLayerMergeReviewPlatform } from './browser-layer-merge-review'

interface Pixels { width: number; height: number; data: Uint8ClampedArray }
function pixels(width: number, height: number, rgba: number[] = [40, 80, 120, 128]): Pixels { return { width, height, data: new Uint8ClampedArray(Array.from({ length: width * height }, () => rgba).flat()) } }
function encode(value: Pixels, signal: AbortSignal): Promise<Blob> { return encodeImportedPsdLayerPng({ ...value, data: new Uint8ClampedArray(value.data), name: 'Owned review fixture', left: 0, top: 0, visible: true, opacity: 1, blend: 'source-over' }, signal) }
async function decode(blob: Blob): Promise<Pixels> {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer), width = view.getUint32(16), height = view.getUint32(20), compressed: Uint8Array[] = []
  for (let at = 8; at + 12 <= bytes.length;) { const size = view.getUint32(at); if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'IDAT') compressed.push(bytes.subarray(at + 8, at + 8 + size)); at += size + 12 }
  const raw = inflateSync(Buffer.concat(compressed)), data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) { expect(raw[y * (width * 4 + 1)]).toBe(0); data.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4) }
  return { width, height, data }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
async function fixture() {
  const recipe: ImageLayerRecipe = { kind: 'layer', explicitLayers: true, outputWidth: 4, outputHeight: 2, background: '#204060', layers: [defaultEditorImageLayer(0), { ...defaultEditorImageLayer(1), blend: 'multiply' }, { ...defaultEditorImageLayer(2), blend: 'screen' }] }
  const state = selectEditorLayer(selectEditorLayer(createLayerEditorState(recipe, 3), 'layer-1'), 'layer-3', { toggle: true })
  const plan = buildEditorLayerMergePlan(state.present), signal = new AbortController().signal, output = { blob: await encode(pixels(4, 2), signal), width: 4, height: 2 }
  const close = vi.fn(), sourceImages = Array.from({ length: 3 }, () => ({ image: {} as CanvasImageSource, width: 4, height: 2 }))
  const sample = vi.fn<BrowserEditorLayerMergeReviewPlatform['sample']>(async (input) => {
    const value = pixels(4, 2)
    if (input.recipe.layers.some((layer) => layer.sourceIndex === 1 && layer.blend === 'source-over')) value.data[0] = 70
    return value
  })
  const merge = vi.fn<BrowserEditorLayerMergeReviewPlatform['merge']>(async () => output), encoding = vi.fn(encode)
  const decoding = vi.fn<BrowserEditorLayerMergeReviewPlatform['decode']>(async (blob) => { const value = await decode(blob); return { image: value as unknown as CanvasImageSource, width: value.width, height: value.height, close } })
  return { state, plan, input: { sources: new Map(sourceImages.map((source, index) => [index, source])), originalSourceSizes: sourceImages.map(({ width, height }) => ({ width, height })), sourceIndex: 3, replacementId: 'layer-4' }, output, close, sample, merge, encoding, decoding, reviewer: createBrowserEditorLayerMergeReviewer({ merge, sample, decode: decoding, encode: encoding }) }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('complete-document merge comparison', () => {
  it('distinguishes visible premultiplied differences from invisible transparent RGB', async () => {
    const before = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 0, 100, 50, 0, 128]) }, after = { width: 2, height: 1, data: new Uint8ClampedArray([0, 200, 0, 0, 100, 50, 0, 64]) }
    const result = await compareEditorLayerMergePixels(before, after, new AbortController().signal)
    expect(result.comparison).toEqual({ width: 2, height: 1, totalPixels: 2, changedPixels: 1, maxChannelDelta: 64, meanChannelDelta: 101 / 8, rawChangedPixels: 2, rawMaxChannelDelta: 255 })
    expect([...result.before.data]).toEqual([...before.data]); expect([...result.after.data]).toEqual([...after.data])
    expect([...result.difference.data.slice(0, 4)]).toEqual([0, 0, 0, 0]); expect(result.difference.data[7]).toBe(255)
  })
  it('compares every native pixel even when a single changed pixel lies between thumbnail sample points', async () => {
    const before = pixels(2049, 1, [0, 0, 0, 255]), after = pixels(2049, 1, [0, 0, 0, 255]); after.data[4] = 1
    const result = await compareEditorLayerMergePixels(before, after, new AbortController().signal)
    expect(result.comparison).toMatchObject({ totalPixels: 2049, changedPixels: 1, maxChannelDelta: 1 })
    expect(result.difference.width).toBe(1024); expect(result.difference.data.some((value) => value === 255)).toBe(true)
  })
  it('rejects wrong output shapes and yields to cancellation without returning thumbnails', async () => {
    await expect(compareEditorLayerMergePixels(pixels(2, 2), pixels(1, 1), new AbortController().signal)).rejects.toThrow('尺寸')
    const controller = new AbortController(), pending = compareEditorLayerMergePixels(pixels(1024, 1024), pixels(1024, 1024), controller.signal)
    controller.abort(); await expect(pending).rejects.toThrow('取消')
  })
})

describe('bounded merge review transaction', () => {
  it('renders both full documents with the unselected backdrop and the exact encoded replacement, without committing or uploading', async () => {
    const f = await fixture(), result = await f.reviewer(f.plan, f.input)
    expect(f.merge).toHaveBeenCalledOnce(); expect(f.decoding).toHaveBeenCalledWith(f.output.blob)
    expect(f.sample).toHaveBeenCalledTimes(2)
    const [before] = f.sample.mock.calls[0], [after] = f.sample.mock.calls[1]
    expect(before.recipe.background).toBe('#204060'); expect(before.recipe.layers).toHaveLength(3)
    expect(before.sources).toHaveLength(3); expect(before.recipe.layers[1].blend).toBe('multiply')
    expect(after.recipe.layers).toHaveLength(2); expect(after.recipe.layers[0].blend).toBe('multiply')
    const replacement = after.sources[after.recipe.layers[1].sourceIndex].image as unknown as Pixels
    expect([...replacement.data]).toEqual([...((await decode(f.output.blob)).data)])
    expect(result.output).toBe(f.output); expect(result.candidate.recipe.layers).toHaveLength(2)
    expect(result.comparison).toMatchObject({ width: 4, height: 2, totalPixels: 8 })
    expect(f.encoding).toHaveBeenCalledTimes(3); expect(f.close).toHaveBeenCalledOnce()
    expect(f.state.past).toHaveLength(0); expect(f.state.present.recipe.layers).toHaveLength(3)
    for (const blob of [result.before, result.after, result.difference]) expect(await decode(blob)).toMatchObject({ width: 4, height: 2 })
  })
  it.each(['missing-backdrop', 'source-conflict', 'source-budget', 'bad-png', 'decode-size', 'bad-pixels', 'bad-thumbnail'] as const)('refuses %s and retains the original state', async (failure) => {
    const f = await fixture()
    if (failure === 'missing-backdrop') f.input.sources.delete(1)
    if (failure === 'source-conflict') f.input.sourceIndex = 1
    if (failure === 'source-budget') f.input.sources.set(1, { image: {} as CanvasImageSource, width: 8192, height: 8192 })
    if (failure === 'bad-png') f.output.blob = new Blob(['bad'], { type: 'image/png' })
    if (failure === 'decode-size') f.decoding.mockResolvedValue({ image: {} as CanvasImageSource, width: 3, height: 2, close: f.close })
    if (failure === 'bad-pixels') f.sample.mockResolvedValue(pixels(1, 1))
    if (failure === 'bad-thumbnail') f.encoding.mockResolvedValue(new Blob(['bad'], { type: 'image/png' }))
    await expect(f.reviewer(f.plan, f.input)).rejects.toThrow()
    expect(f.state.past).toHaveLength(0); expect(f.state.present.recipe.layers).toHaveLength(3)
    if (['missing-backdrop', 'source-conflict', 'source-budget'].includes(failure)) expect(f.merge).not.toHaveBeenCalled()
    if (['decode-size', 'bad-pixels', 'bad-thumbnail'].includes(failure)) expect(f.close).toHaveBeenCalledOnce()
  })
  it('releases an actual decoded replacement that arrives after cancellation', async () => {
    const f = await fixture(), controller = new AbortController(), pending = deferred<Awaited<ReturnType<BrowserEditorLayerMergeReviewPlatform['decode']>>>()
    f.decoding.mockImplementation(() => pending.promise)
    const result = f.reviewer(f.plan, { ...f.input, signal: controller.signal }), rejected = expect(result).rejects.toThrow('取消')
    for (let index = 0; index < 100 && !f.decoding.mock.calls.length; index++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f.decoding).toHaveBeenCalledOnce(); controller.abort(); await rejected
    pending.resolve({ image: {} as CanvasImageSource, width: 4, height: 2, close: f.close }); await Promise.resolve(); await Promise.resolve()
    expect(f.close).toHaveBeenCalledOnce(); expect(f.sample).not.toHaveBeenCalled()
  })
  it('retains an owned LUT required by a selected zero-opacity layer in the raster snapshot', async () => {
    const f = await fixture(), table = parseColorLutCube('TITLE "Owned invisible inverse"\nLUT_1D_SIZE 2\n1 1 1\n0 0 0')
    const lut: ColorLutSelection = { version: 1, enabled: true, strength: 100, source: { kind: 'asset', lutAssetId: 'a'.repeat(43), digest: 'b'.repeat(64), name: table.name, domainMin: [0, 0, 0], domainMax: [1, 1, 1] } }
    f.state.present.recipe.layers[0].opacity = 0
    f.state.present.recipe.layers[0].colorGrade = { ...defaultImageLayerColorGrade(), lut }
    f.merge.mockImplementation(async (plan, input) => { const prepared = snapshotLayerColorLutTables(plan.rasterRecipe, input.lutTables); expect(prepared.get(colorLutSourceKey(lut.source))).toMatchObject({ name: table.name }); return f.output })
    await f.reviewer(buildEditorLayerMergePlan(f.state.present), { ...f.input, lutTables: new Map([[colorLutSourceKey(lut.source), table]]) })
    expect(f.merge).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce()
  })
  it('compares retained pixels outside a crop and describes the visible output window separately', async () => {
    const f = await fixture(), recipe = f.state.present.recipe
    recipe.documentFrame = { version: 1, width: 4, height: 2, offsetX: 1, offsetY: 1 }; recipe.outputWidth = 2; recipe.outputHeight = 1
    recipe.layers = recipe.layers.map((layer) => ({ ...layer, x: (layer.x * 4 - 1) / 2, y: -1, width: layer.width * 2, height: 2 }))
    const result = await f.reviewer(buildEditorLayerMergePlan(f.state.present), f.input)
    expect(result.comparison).toMatchObject({ width: 4, height: 2, totalPixels: 8, changedPixels: 1, outputWindow: { x: 1, y: 1, width: 2, height: 1 } })
    for (const [input] of f.sample.mock.calls) { expect(input.recipe.documentFrame).toBeUndefined(); expect([input.recipe.outputWidth, input.recipe.outputHeight]).toEqual([4, 2]) }
    // This changed pixel is at native (0,0), outside the current 2x1 crop.
    expect(f.sample.mock.calls[0][0].recipe.layers[0]).toMatchObject({ x: 0, y: 0, width: 1, height: 1 })
    expect(result.candidate.recipe.documentFrame).toEqual(recipe.documentFrame)
  })
  it('times out a non-cooperative rasterizer without decoding or committing', async () => {
    const f = await fixture(), pending = deferred<typeof f.output>()
    f.merge.mockImplementation(() => pending.promise)
    vi.useFakeTimers()
    const result = f.reviewer(f.plan, f.input), rejected = expect(result).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(90001); await rejected
    pending.resolve(f.output); await Promise.resolve()
    expect(f.decoding).not.toHaveBeenCalled(); expect(f.sample).not.toHaveBeenCalled(); expect(f.state.past).toHaveLength(0)
  })
  it('checks every retained input plus the new PNG against the actual execution budget before rasterizing', async () => {
    const f = await fixture()
    // The third original input can be unused by the current visible recipe,
    // yet remains an execution input after applying the appended PNG.
    f.input.originalSourceSizes = [{ width: 8192, height: 4096 }, { width: 1, height: 1 }, { width: 1, height: 1 }]
    await expect(f.reviewer(f.plan, f.input)).rejects.toThrow('总像素')
    expect(f.merge).not.toHaveBeenCalled(); expect(f.sample).not.toHaveBeenCalled(); expect(f.state.past).toHaveLength(0)
  })
  it.each(['missing-size', 'non-finite-size', 'count-mismatch'] as const)('refuses %s without estimating away unused original inputs', async (failure) => {
    const f = await fixture()
    if (failure === 'missing-size') f.input.originalSourceSizes[2] = { width: 0, height: 0 }
    if (failure === 'non-finite-size') f.input.originalSourceSizes[2] = { width: Infinity, height: 1 }
    if (failure === 'count-mismatch') f.input.originalSourceSizes.pop()
    await expect(f.reviewer(f.plan, f.input)).rejects.toThrow('素材尺寸')
    expect(f.merge).not.toHaveBeenCalled()
  })
  it('prevents a late full-document sample from producing a review after cancellation', async () => {
    const f = await fixture(), controller = new AbortController(), pending = deferred<Pixels>()
    f.sample.mockImplementation(() => pending.promise)
    const result = f.reviewer(f.plan, { ...f.input, signal: controller.signal }), rejected = expect(result).rejects.toThrow('取消')
    for (let index = 0; index < 100 && !f.sample.mock.calls.length; index++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f.sample).toHaveBeenCalledOnce(); controller.abort(); await rejected
    pending.resolve(pixels(4, 2)); await Promise.resolve()
    expect(f.sample).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce(); expect(f.encoding).not.toHaveBeenCalled()
  })
})
