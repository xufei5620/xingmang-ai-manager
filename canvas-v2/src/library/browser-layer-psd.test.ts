import { describe, expect, it, vi } from 'vitest'
import fixtures from '../lib/fixtures/generated-image-headers.json'
import type { ImageLayer, ImageLayerRecipe } from '../image-tools/recipe'
import { createBrowserLayerPsdExporter, inspectLayerPsdRecipe, type LayerPsdDecodedSource } from './browser-layer-psd'
import type { BrowserImageLayerPixelsInput } from './browser-image-transform'
import { layerVectorRecipeFixture } from '../image-tools/layer-vector.test-fixture'
import { defaultImageLayerColorGrade } from '../image-tools/layer-color-grade'
import { readLayerPsd } from './layer-psd-reader'
import { parseColorLutCube } from '../image-tools/layer-color-lut'
import { colorLutSourceKey, type ColorLutSelection } from '../image-tools/layer-color-lut-selection'

function layer(change: Partial<ImageLayer> = {}): ImageLayer { return { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 0.5, blend: 'multiply', visible: false, name: '隐藏图层', content: { kind: 'paint' }, ...change } }
function recipe(layers = [layer()]): ImageLayerRecipe { return { kind: 'layer', outputWidth: 3, outputHeight: 2, background: 'transparent', explicitLayers: true, layers } }
function fixture() {
  const bitmap = { image: {} as CanvasImageSource, width: 7, height: 5, close: vi.fn() }
  const decode = vi.fn(async (): Promise<LayerPsdDecodedSource> => bitmap)
  const sample = vi.fn(async (input: BrowserImageLayerPixelsInput) => ({ width: input.recipe.outputWidth, height: input.recipe.outputHeight, data: new Uint8ClampedArray(input.recipe.outputWidth * input.recipe.outputHeight * 4) }))
  return { bitmap, decode, sample, exportPsd: createBrowserLayerPsdExporter({ decode, sample }) }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { resolve, promise } }
function source(name: keyof typeof fixtures = 'baseline', type = 'image/jpeg') { return new Blob([new Uint8Array(Buffer.from(fixtures[name], 'base64'))], { type }) }

describe('browser layered PSD export', () => {
  it('exports real folders with own flags while rendering each raster independently', async () => {
    const f = fixture(), original: ImageLayerRecipe = { ...recipe([layer({ visible: true, locked: false }), layer({ name: '标题', visible: false })]), layerGroups: { version: 1, layerIds: ['bottom', 'top'], groups: [{ id: 'folder', name: '海报', children: ['bottom', 'top'], visible: false, locked: true }] } }, before = structuredClone(original)
    const result = await f.exportPsd({ recipe: original, sources: [] })
    expect(result.groupCount).toBe(1)
    expect(result.layerCount).toBe(2)
    for (const [input] of f.sample.mock.calls.slice(0, 2)) {
      expect(input.recipe.layerGroups).toBeUndefined()
      expect(input.recipe.layers).toHaveLength(1)
      expect(input.recipe.layers[0]).toMatchObject({ visible: true, opacity: 1, blend: 'source-over' })
    }
    expect(f.sample.mock.calls[2][0].recipe).toEqual(original)
    const read = await readLayerPsd(new Uint8Array(await result.blob.arrayBuffer()))
    expect(read.layerGroups?.groups).toMatchObject([{ name: '海报', visible: false, locked: true }])
    expect(read.layers.map((entry) => entry.visible)).toEqual([true, false])
    expect(original).toEqual(before)
  })

  it('captures one owned LUT snapshot for hidden layer pixels and composite and rejects a missing resource first', async () => {
    const f = fixture(), table = parseColorLutCube('TITLE "Owned inverse"\nLUT_1D_SIZE 2\n1 1 1\n0 0 0'), lut: ColorLutSelection = { version: 1, enabled: true, strength: 100, source: { kind: 'asset', lutAssetId: 'a'.repeat(43), digest: 'b'.repeat(64), name: table.name, domainMin: [0, 0, 0], domainMax: [1, 1, 1] } }
    const original = recipe([layer({ colorGrade: { ...defaultImageLayerColorGrade(), lut } })]), caller = new Map([[colorLutSourceKey(lut.source), table]])
    await expect(f.exportPsd({ recipe: original, sources: [] })).rejects.toThrow(/LUT.*尚未准备/)
    expect(f.sample).not.toHaveBeenCalled()
    const result = f.exportPsd({ recipe: original, sources: [], lutTables: caller })
    table.data.fill(0); caller.clear()
    await result
    const captured = f.sample.mock.calls[0][0].lutTables!
    expect(captured.get(colorLutSourceKey(lut.source))?.data[0]).toBe(1)
    expect(f.sample.mock.calls[1][0].lutTables).toBe(captured)
    expect(f.sample.mock.calls[0][0].recipe.layers[0]).toMatchObject({ visible: true, opacity: 1, blend: 'source-over' })
  })

  it('passes the same grade to individual PSD layers and the composite without baking opacity twice', async () => {
    const f = fixture(), grade = { ...defaultImageLayerColorGrade(), exposure: 1, temperature: 6500, tint: 15 }
    const original = recipe([layer({ visible: true, colorGrade: grade })]), before = structuredClone(original)
    await f.exportPsd({ recipe: original, sources: [] })
    expect(f.sample).toHaveBeenCalledTimes(2)
    expect(f.sample.mock.calls[0][0].recipe.layers[0]).toMatchObject({ colorGrade: grade, opacity: 1, blend: 'source-over' })
    expect(f.sample.mock.calls[1][0].recipe.layers[0]).toMatchObject({ colorGrade: grade, opacity: .5, blend: 'multiply' })
    expect(original).toEqual(before)
  })
  it('renders hidden layers at full opacity with normal blend but keeps the original composite recipe', async () => {
    const f = fixture(), original = recipe(), before = structuredClone(original)
    const result = await f.exportPsd({ recipe: original, sources: [] })
    expect(result.layerCount).toBe(1)
    expect(result.blob.type).toBe('image/vnd.adobe.photoshop')
    expect(f.decode).not.toHaveBeenCalled()
    expect(f.sample.mock.calls[0][0].recipe.layers[0]).toEqual({ ...original.layers[0], visible: true, opacity: 1, blend: 'source-over' })
    expect(f.sample.mock.calls[1][0].recipe).toEqual(original)
    expect(original).toEqual(before)
  })

  it('exports nontransparent background as a separate bottom layer and preserves hidden bitmap sources', async () => {
    const f = fixture(), original = { ...recipe([layer({ content: undefined })]), background: '#12345680' }
    const result = await f.exportPsd({ recipe: original, sources: [source()] })
    expect(result.layerCount).toBe(2)
    expect(f.sample.mock.calls[0][0].recipe.layers[0].content).toMatchObject({ kind: 'shape', fill: '#12345680' })
    expect(f.sample.mock.calls[1][0].recipe.layers[0].content).toBeUndefined()
    expect(f.sample.mock.calls[2][0].recipe).toEqual(original)
    expect(f.bitmap.close).toHaveBeenCalledOnce()
  })

  it('preserves path handles, gradients, masks and transformations while separating layer compositing metadata', async () => {
    const f = fixture(), original = layerVectorRecipeFixture(), before = structuredClone(original)
    await f.exportPsd({ recipe: original, sources: [] })
    expect(f.sample.mock.calls[0][0].recipe.layers[0]).toEqual({ ...original.layers[0], opacity: 1, blend: 'source-over', visible: true })
    expect(f.sample.mock.calls[1][0].recipe).toEqual(original)
    expect(original).toEqual(before)
    expect(f.decode).not.toHaveBeenCalled()
  })

  it('materializes legacy automatic input layers without changing an explicit blank canvas', () => {
    expect(inspectLayerPsdRecipe({ ...recipe([]), explicitLayers: undefined }, 2).layers).toHaveLength(2)
    expect(inspectLayerPsdRecipe(recipe([]), 0).layers[0]).toMatchObject({ name: '透明背景', content: { kind: 'paint' } })
  })

  it('rejects missing hidden sources and oversized raster output before any decoding', async () => {
    const f = fixture()
    await expect(f.exportPsd({ recipe: recipe([layer({ content: undefined })]), sources: [] })).rejects.toThrow('来源')
    await expect(f.exportPsd({ recipe: { ...recipe([layer(), layer()]), outputWidth: 4096, outputHeight: 4096 }, sources: [] })).rejects.toThrow('容量')
    expect(f.decode).not.toHaveBeenCalled(); expect(f.sample).not.toHaveBeenCalled()
  })

  it.each([['animated', 'image/webp'], ['apng', 'image/png'], ['baseline', 'image/png']] as const)('rejects animated or mislabeled %s before decode', async (name, type) => {
    const f = fixture()
    await expect(f.exportPsd({ recipe: recipe([layer({ content: undefined })]), sources: [source(name, type)] })).rejects.toThrow('静态')
    expect(f.decode).not.toHaveBeenCalled()
  })

  it('rejects a malformed source and releases an incorrectly sized decoded bitmap', async () => {
    const f = fixture()
    await expect(f.exportPsd({ recipe: recipe([layer({ content: undefined })]), sources: [new Blob(['bad'])] })).rejects.toThrow('格式无效')
    f.bitmap.width = 90
    await expect(f.exportPsd({ recipe: recipe([layer({ content: undefined })]), sources: [source()] })).rejects.toThrow('尺寸不一致')
    expect(f.bitmap.close).toHaveBeenCalledOnce()
  })

  it('cancels while decoding and closes the late bitmap without starting rasterization', async () => {
    const f = fixture(), pending = deferred<LayerPsdDecodedSource>(), controller = new AbortController()
    f.decode.mockReturnValue(pending.promise)
    const exporting = f.exportPsd({ recipe: recipe([layer({ content: undefined })]), sources: [source()], signal: controller.signal })
    await vi.waitFor(() => expect(f.decode).toHaveBeenCalledOnce())
    controller.abort()
    await expect(exporting).rejects.toMatchObject({ name: 'AbortError' })
    pending.resolve(f.bitmap); await Promise.resolve()
    expect(f.bitmap.close).toHaveBeenCalledOnce(); expect(f.sample).not.toHaveBeenCalled()
  })

  it('releases decoded sources after a painter failure', async () => {
    const f = fixture(); f.sample.mockRejectedValue(new Error('画笔失败'))
    await expect(f.exportPsd({ recipe: recipe([layer({ content: undefined })]), sources: [source()] })).rejects.toThrow('画笔失败')
    expect(f.bitmap.close).toHaveBeenCalledOnce()
  })
})
