import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseColorLutCube, type ColorLutTable } from './layer-color-lut'
import { colorLutSourceKey, type AssetColorLutSource, type ColorLutSelection } from './layer-color-lut-selection'
import { defaultImageLayerColorGrade } from './layer-color-grade'
import { getPreparedColorLutTable, prepareLayerColorLuts, snapshotLayerColorLutTables } from './layer-color-lut-runtime'
import type { ImageLayerRecipe } from './recipe'

function table() { return parseColorLutCube('TITLE "Owned inverse"\nLUT_1D_SIZE 2\n1 1 1\n0 0 0') }
function source(index = 0): AssetColorLutSource { return { kind: 'asset', lutAssetId: String.fromCharCode(65 + index).repeat(43), digest: index.toString(16).padStart(64, '0'), name: 'Owned inverse', domainMin: [0, 0, 0], domainMax: [1, 1, 1] } }
function selection(index = 0): ColorLutSelection { return { version: 1, enabled: true, strength: 100, source: source(index) } }
function recipe(selections: Array<ColorLutSelection | undefined> = [selection()]): ImageLayerRecipe { return { kind: 'layer', outputWidth: 2, outputHeight: 2, background: 'transparent', explicitLayers: true, layers: selections.map((lut) => ({ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, content: { kind: 'paint' }, ...(lut ? { colorGrade: { ...defaultImageLayerColorGrade(), lut } } : {}) })) } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { resolve, promise } }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('per-job bounded owned LUT resource preparation', () => {
  it('loads each active asset once, including hidden PSD layers, while skipping inactive and builtin sources', async () => {
    const value = recipe([selection(), selection(), { ...selection(1), enabled: false }, { ...selection(2), strength: 0 }, { version: 1, enabled: true, strength: 100, source: { kind: 'builtin', presetId: 'xm-lut-movie-tone-v1' } }, undefined]), loader = vi.fn(async () => table())
    value.layers[0].visible = false
    const result = await prepareLayerColorLuts(value, loader)
    expect(loader).toHaveBeenCalledOnce(); expect(loader.mock.calls[0]).toHaveLength(2)
    expect(result.size).toBe(1); expect(getPreparedColorLutTable(selection(), result)?.data[0]).toBe(1)
    expect(getPreparedColorLutTable(undefined)).toBeUndefined()
    expect(getPreparedColorLutTable({ ...selection(), enabled: false })).toBeUndefined()
    expect(getPreparedColorLutTable({ ...selection(), strength: 0 })).toBeUndefined()
    expect(getPreparedColorLutTable(value.layers[4].colorGrade?.lut)).toBeUndefined()
  })

  it('takes independent recipe and table snapshots and has no cross-job cache', async () => {
    const value = recipe(), original = table(), pending = deferred<ColorLutTable>(), loader = vi.fn(() => pending.promise)
    const preparing = prepareLayerColorLuts(value, loader)
    const captured = value.layers[0].colorGrade!.lut!.source
    if (captured.kind === 'asset') { captured.name = 'Later edit'; captured.domainMin[0] = -1 }
    pending.resolve(original)
    const result = await preparing
    original.data.fill(0); original.domainMin[0] = -1
    expect(getPreparedColorLutTable(selection(), result)?.data[0]).toBe(1)
    await prepareLayerColorLuts(recipe(), async () => table())
    loader.mockReturnValueOnce(Promise.resolve(table()))
    const another = await prepareLayerColorLuts(recipe(), loader)
    expect(loader).toHaveBeenCalledTimes(2)
    expect(another.get(colorLutSourceKey(source()))).not.toBe(result.get(colorLutSourceKey(source())))
  })

  it('isolates a prepared output job from subsequent caller map and float mutations', () => {
    const original = table(), caller = new Map([[colorLutSourceKey(source()), original]]), captured = snapshotLayerColorLutTables(recipe(), caller)
    original.data.fill(0); original.domainMax[0] = 2; caller.clear()
    expect(getPreparedColorLutTable(selection(), captured)?.data[0]).toBe(1)
    expect(snapshotLayerColorLutTables(recipe([undefined])).size).toBe(0)
  })

  it('rejects missing, malformed or differently described resources instead of omitting LUT pixels', async () => {
    expect(() => getPreparedColorLutTable(selection())).toThrow(/尚未准备/)
    expect(() => snapshotLayerColorLutTables(recipe())).toThrow(/尚未准备/)
    for (const patch of [{ name: 'Other' }, { domainMin: [-1, 0, 0] }, { domainMax: [2, 1, 1] }, { data: new Float32Array(3) }, { version: 2 }]) {
      const wrong = { ...table(), ...patch } as ColorLutTable, entries = new Map([[colorLutSourceKey(source()), wrong]])
      expect(() => getPreparedColorLutTable(selection(), entries)).toThrow(/LUT/)
      await expect(prepareLayerColorLuts(recipe(), async () => wrong)).rejects.toThrow(/LUT/)
    }
    const bad = table(); bad.data[30000] = NaN
    await expect(prepareLayerColorLuts(recipe(), async () => bad)).rejects.toThrow(/LUT/)
  })

  it('rejects a contradictory description for the same immutable source before loading', async () => {
    const other = selection(); if (other.source.kind === 'asset') other.source.name = 'Changed'
    const loader = vi.fn(async () => table())
    await expect(prepareLayerColorLuts(recipe([selection(), other]), loader)).rejects.toThrow(/同一 LUT/)
    expect(loader).not.toHaveBeenCalled()
  })

  it('does not let a loader mutate the captured immutable source description', async () => {
    const value = recipe()
    await expect(prepareLayerColorLuts(value, async (input) => {
      input.name = 'Loader mutation'; input.domainMin[0] = -1
      return { ...table(), name: input.name, domainMin: [...input.domainMin] }
    })).rejects.toThrow(/不匹配/)
    expect(value.layers[0].colorGrade?.lut).toEqual(selection())
  })

  it('has one in-flight loader and accepts the full twenty-layer bound', async () => {
    const pending = deferred<ColorLutTable>(), loader = vi.fn(() => pending.promise), preparing = prepareLayerColorLuts(recipe([selection(), selection(1)]), loader)
    expect(loader).toHaveBeenCalledOnce()
    pending.resolve(table()); expect((await preparing).size).toBe(2); expect(loader).toHaveBeenCalledTimes(2)
    const fullLoader = vi.fn(async () => table())
    expect((await prepareLayerColorLuts(recipe(Array.from({ length: 20 }, (_, at) => selection(at))), fullLoader)).size).toBe(20)
    expect(fullLoader).toHaveBeenCalledTimes(20)
    await expect(prepareLayerColorLuts(recipe(Array.from({ length: 21 }, (_, at) => selection(at))), fullLoader)).rejects.toThrow(/20/)
    expect(fullLoader).toHaveBeenCalledTimes(20)
  })

  it('rejects prior cancellation and deadline before any loader call', async () => {
    const controller = new AbortController(), loader = vi.fn(async () => table()); controller.abort()
    await expect(prepareLayerColorLuts(recipe(), loader, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(prepareLayerColorLuts(recipe(), loader, { deadline: 0 })).rejects.toThrow(/超时/)
    expect(loader).not.toHaveBeenCalled()
  })

  it('settles cancellation even if a loader ignores the signal and does not adopt its late table', async () => {
    const pending = deferred<ColorLutTable>(), controller = new AbortController(), loader = vi.fn((_source: AssetColorLutSource, _signal: AbortSignal) => pending.promise)
    const preparing = prepareLayerColorLuts(recipe(), loader, { signal: controller.signal }), rejected = expect(preparing).rejects.toMatchObject({ name: 'AbortError' })
    const signal = loader.mock.calls[0][1]; controller.abort(); await rejected
    expect(signal.aborted).toBe(true)
    pending.resolve(table()); await Promise.resolve(); await Promise.resolve()
    expect(loader).toHaveBeenCalledOnce()
  })

  it('enforces an overall bounded deadline for an ignoring loader and rejects late success', async () => {
    vi.useFakeTimers()
    const pending = deferred<ColorLutTable>(), loader = vi.fn((_source: AssetColorLutSource, _signal: AbortSignal) => pending.promise), preparing = prepareLayerColorLuts(recipe(), loader), rejected = expect(preparing).rejects.toThrow(/超时/)
    await vi.advanceTimersByTimeAsync(30_001); await rejected
    expect(loader.mock.calls[0][1].aborted).toBe(true)
    pending.resolve(table()); await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })
})
