import { inflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { createBrowserLayerPsdImporter, encodeImportedPsdLayerPng, importBrowserLayerPsd } from './browser-layer-psd-import'
import { buildPsdReaderFixture } from './layer-psd-reader.test-fixture'
import type { ImportedLayerPsdPixels } from './layer-psd-reader'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function fixtureBlob() { return new Blob([buildPsdReaderFixture()]) }
function frame(): ImportedLayerPsdPixels { return { name: '低透明像素', left: 1, top: 2, width: 2, height: 1, visible: false, opacity: 0.5, blend: 'multiply', data: new Uint8ClampedArray([249, 115, 22, 1, 31, 71, 111, 0]) } }
function readPng(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), compressed: Uint8Array[] = []
  let width = 0, height = 0
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') { width = view.getUint32(offset + 8); height = view.getUint32(offset + 12) }
    if (type === 'IDAT') compressed.push(data)
    let crc = 0xffffffff
    for (const byte of bytes.subarray(offset + 4, offset + 8 + length)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1 }
    expect(view.getUint32(offset + 8 + length)).toBe((crc ^ 0xffffffff) >>> 0)
    offset += length + 12
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(compressed))), pixels: number[] = []
  for (let row = 0; row < height; row++) { expect(raw[row * (width * 4 + 1)]).toBe(0); pixels.push(...raw.subarray(row * (width * 4 + 1) + 1, (row + 1) * (width * 4 + 1))) }
  expect(raw.length).toBe((width * 4 + 1) * height)
  return { width, height, pixels }
}

describe('local layered PSD PNG import', () => {
  it('encodes exact straight RGBA including alpha-one and hidden alpha-zero color without a canvas', async () => {
    const layer = frame(), blob = await encodeImportedPsdLayerPng(layer, new AbortController().signal)
    expect(blob.type).toBe('image/png')
    expect(readPng(new Uint8Array(await blob.arrayBuffer()))).toEqual({ width: 2, height: 1, pixels: Array.from(layer.data) })
  })

  it('converts all independent layers in order while keeping metadata unbaked and never fetching', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    try {
      const layers = [{ name: '底图', pixels: [249, 115, 22, 1, 31, 71, 111, 0] }, { name: '上图', width: 1, left: 1, pixels: [17, 19, 23, 128], opacity: 128, flags: 10, blend: 'mul ' }]
      const result = await importBrowserLayerPsd(new Blob([buildPsdReaderFixture({ layers })]))
      expect(result).toMatchObject({ width: 2, height: 1, warnings: [] })
      expect(result.layers.map(({ name }) => name)).toEqual(['底图', '上图'])
      expect(result.layers[1]).toMatchObject({ left: 1, width: 1, opacity: 128 / 255, visible: false, blend: 'multiply' })
      expect(readPng(new Uint8Array(await result.layers[0].blob.arrayBuffer())).pixels).toEqual(layers[0].pixels)
      expect(readPng(new Uint8Array(await result.layers[1].blob.arrayBuffer())).pixels).toEqual(layers[1].pixels)
      expect(fetch).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects unsupported metadata before the encoder is invoked', async () => {
    const encode = vi.fn(encodeImportedPsdLayerPng), importPsd = createBrowserLayerPsdImporter({ encode })
    await expect(importPsd(new Blob([buildPsdReaderFixture({ layers: [{ clipping: 1 }] })]))).rejects.toThrow('剪贴')
    expect(encode).not.toHaveBeenCalled()
  })

  it('cancels a pending file read without starting PNG encoding', async () => {
    const pending = deferred<ArrayBuffer>(), blob = fixtureBlob(), controller = new AbortController(), encode = vi.fn(encodeImportedPsdLayerPng)
    vi.spyOn(blob, 'arrayBuffer').mockReturnValue(pending.promise)
    const task = createBrowserLayerPsdImporter({ encode })(blob, { signal: controller.signal })
    controller.abort()
    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    pending.resolve(new ArrayBuffer(0)); await Promise.resolve()
    expect(encode).not.toHaveBeenCalled()
  })

  it('cancels a pending encode and ignores its late result without returning partial layers', async () => {
    const pending = deferred<Blob>(), controller = new AbortController(), encode = vi.fn(async () => pending.promise)
    const task = createBrowserLayerPsdImporter({ encode })(fixtureBlob(), { signal: controller.signal })
    await vi.waitFor(() => expect(encode).toHaveBeenCalledOnce())
    controller.abort()
    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    pending.resolve(new Blob(['late'], { type: 'image/png' })); await Promise.resolve()
    expect(encode).toHaveBeenCalledOnce()
  })

  it('rejects invalid PNG dimensions, media type and encoded byte size', async () => {
    const wrongSize = await encodeImportedPsdLayerPng({ ...frame(), width: 1, data: new Uint8ClampedArray([1, 2, 3, 4]) }, new AbortController().signal)
    await expect(createBrowserLayerPsdImporter({ encode: async () => wrongSize })(fixtureBlob())).rejects.toThrow('尺寸不一致')
    await expect(createBrowserLayerPsdImporter({ encode: async () => new Blob(['bad'], { type: 'image/jpeg' }) })(fixtureBlob())).rejects.toThrow('PNG 转换结果')
    const large = new Blob(['x'], { type: 'image/png' }); Object.defineProperty(large, 'size', { value: 20 * 1024 * 1024 + 1 })
    await expect(createBrowserLayerPsdImporter({ encode: async () => large })(fixtureBlob())).rejects.toThrow('20 MB')
  })

  it('checks the complete PNG byte budget instead of returning a partial imported stack', async () => {
    const blob = await encodeImportedPsdLayerPng({ ...frame(), data: new Uint8ClampedArray(8) }, new AbortController().signal)
    Object.defineProperty(blob, 'size', { value: 17 * 1024 * 1024 })
    const encode = vi.fn(async () => blob), input = new Blob([buildPsdReaderFixture({ layers: [{}, {}, {}, {}] })])
    await expect(createBrowserLayerPsdImporter({ encode })(input)).rejects.toThrow('64 MB')
    expect(encode).toHaveBeenCalledTimes(4)
  })

  it('rejects an unavailable compressor and invalid frame before allocating encoding surfaces', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    try { await expect(encodeImportedPsdLayerPng(frame(), new AbortController().signal)).rejects.toThrow('新版浏览器') } finally { vi.unstubAllGlobals() }
    await expect(encodeImportedPsdLayerPng({ ...frame(), width: 0 }, new AbortController().signal)).rejects.toThrow('像素无效')
    const controller = new AbortController(); controller.abort()
    await expect(encodeImportedPsdLayerPng(frame(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('enforces the input byte cap before reading the file', async () => {
    const blob = fixtureBlob(), read = vi.spyOn(blob, 'arrayBuffer')
    Object.defineProperty(blob, 'size', { value: 200 * 1024 * 1024 })
    await expect(importBrowserLayerPsd(blob)).rejects.toThrow('128 MB')
    expect(read).not.toHaveBeenCalled()
  })
})
