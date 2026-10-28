import { inflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { generatedImageInfo } from '../lib/generation-protocol'
import { parseImageEditMask, rasterizeImageEditMask, readImageEditMaskPixel, type ImageEditMask } from './image-edit-mask'
import { encodeImageMaskPng } from './image-mask-png'

const ownerAsset = 'a'.repeat(43)
function mask(width = 19, height = 13): ImageEditMask { return { version: 1, sourceAssetId: ownerAsset, width, height, strokes: [{ tool: 'brush', size: .7, points: [{ x: 0, y: .5 }, { x: 1, y: .5 }] }, { tool: 'erase', size: .18, points: [{ x: .5, y: .5 }] }] } }
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1 }
  return (crc ^ 0xffffffff) >>> 0
}
async function decode(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer), compressed: Uint8Array[] = [], types: string[] = []
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  for (let at = 8; at < bytes.length;) {
    const size = view.getUint32(at), type = String.fromCharCode(...bytes.slice(at + 4, at + 8)); types.push(type)
    expect(view.getUint32(at + 8 + size)).toBe(crc32(bytes.slice(at + 4, at + 8 + size)))
    if (type === 'IDAT') compressed.push(bytes.slice(at + 8, at + 8 + size))
    at += size + 12
    expect(at).toBeLessThanOrEqual(bytes.length)
  }
  const width = view.getUint32(16), height = view.getUint32(20), stride = Math.ceil(width / 8) + 1
  expect([...bytes.slice(24, 29)]).toEqual([1, 0, 0, 0, 0]); expect(types[0]).toBe('IHDR'); expect(types.at(-1)).toBe('IEND')
  expect(types.filter((type) => type !== 'IHDR' && type !== 'IDAT' && type !== 'IEND')).toEqual([])
  const raw = inflateSync(Buffer.concat(compressed)); expect(raw.length).toBe(stride * height)
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride]).toBe(0)
    for (let x = 0; x < width; x++) {
      const white = (raw[y * stride + 1 + (x >>> 3)] & (128 >>> (x & 7))) !== 0, at = (y * width + x) * 4
      rgba[at] = rgba[at + 1] = rgba[at + 2] = white ? 255 : 0; rgba[at + 3] = 255
    }
  }
  return { bytes, width, height, rgba, idat: compressed.length }
}

describe('opaque original-size image mask PNG', () => {
  it('encodes exact original pixels, black preservation, white paint and opaque alpha with valid CRC and zlib checksums', async () => {
    const value = mask(), raster = rasterizeImageEditMask(value), result = await encodeImageMaskPng(value), png = await decode(result.blob)
    expect(result).toMatchObject({ width: value.width, height: value.height }); expect(result.blob.type).toBe('image/png')
    expect(generatedImageInfo(png.bytes)).toMatchObject({ width: value.width, height: value.height, mimeType: 'image/png' })
    let white = 0, black = 0
    for (let y = 0; y < value.height; y++) for (let x = 0; x < value.width; x++) {
      const wanted = readImageEditMaskPixel(raster, x, y) ? 255 : 0, at = (y * value.width + x) * 4
      expect([...png.rgba.slice(at, at + 4)]).toEqual([wanted, wanted, wanted, 255]); if (wanted) white++; else black++
    }
    expect(white).toBe(raster.editedPixels); expect(black).toBeGreaterThan(0)
  })
  it.each([[1, 1], [7, 3], [8, 3], [9, 3], [4096, 256]])('preserves packed row and non-square boundaries at %i by %i', async (width, height) => {
    const value = { ...mask(width, height), strokes: [{ tool: 'brush' as const, size: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] }, result = await encodeImageMaskPng(value), png = await decode(result.blob)
    expect([png.width, png.height]).toEqual([width, height]); expect(result.blob.size).toBeLessThan(2_200_000)
    if (width === 4096) expect(png.idat).toBeGreaterThan(1)
  })
  it('keeps the maximum 4096 square below the upload budget without allocating an RGBA surface', async () => {
    const value = mask(4096, 4096), cooperate = vi.fn(async () => undefined), result = await encodeImageMaskPng(value, { yieldControl: cooperate })
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    expect(generatedImageInfo(bytes)).toMatchObject({ width: 4096, height: 4096, mimeType: 'image/png' })
    expect(result.blob.size).toBeLessThan(2_200_000); expect(cooperate.mock.calls.length).toBeGreaterThan(30)
    const view = new DataView(bytes.buffer), chunks: Uint8Array[] = []
    for (let at = 8; at < bytes.length;) { const size = view.getUint32(at); if (String.fromCharCode(...bytes.slice(at + 4, at + 8)) === 'IDAT') chunks.push(bytes.slice(at + 8, at + 8 + size)); at += size + 12 }
    const raw = inflateSync(Buffer.concat(chunks)); expect(raw.length).toBe(513 * 4096)
    expect(raw[0]).toBe(0); expect(raw[4095 * 513]).toBe(0)
  })
  it('produces deterministic bytes from a captured recipe despite caller mutation while yielding', async () => {
    const value = mask(), before = parseImageEditMask(value), yieldControl = vi.fn(async () => { value.width = 1; value.strokes.length = 0 })
    const actual = await encodeImageMaskPng(value, { yieldControl }), expected = await encodeImageMaskPng(before)
    expect(new Uint8Array(await actual.blob.arrayBuffer())).toEqual(new Uint8Array(await expected.blob.arrayBuffer()))
  })
  it('rejects empty and fully erased masks instead of creating an empty reusable asset', async () => {
    await expect(encodeImageMaskPng({ ...mask(), strokes: [] })).rejects.toThrow('没有可修改区域')
    const full = { tool: 'brush' as const, size: 1, points: [{ x: .5, y: .5 }] }
    await expect(encodeImageMaskPng({ ...mask(1, 1), strokes: [full, { ...full, tool: 'erase' }] })).rejects.toThrow('没有可修改区域')
  })
  it('checks an already aborted signal before reading hostile input', async () => {
    const controller = new AbortController(); controller.abort()
    const value = Object.defineProperty({}, 'width', { get() { throw Error('must not read') } })
    await expect(encodeImageMaskPng(value as ImageEditMask, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError', message: '蒙版图片导出已取消' })
  })
  it('cancels before rasterization and during chunked encoding without returning a partial PNG', async () => {
    for (const stopAt of [1, 2, 3]) {
      const controller = new AbortController(); let turns = 0
      await expect(encodeImageMaskPng(mask(4096, 256), { signal: controller.signal, yieldControl: async () => { if (++turns === stopAt) controller.abort() } })).rejects.toMatchObject({ name: 'AbortError' })
      expect(turns).toBe(stopAt)
    }
  })
  it('retains all existing parse and raster work budgets', async () => {
    await expect(encodeImageMaskPng({ ...mask(), width: 4097 })).rejects.toThrow('4096')
    await expect(encodeImageMaskPng({ ...mask(), version: 2 } as unknown as ImageEditMask)).rejects.toThrow('尺寸无效')
    await expect(encodeImageMaskPng({ ...mask(), sourceAssetId: 'bad' })).rejects.toThrow('原图编号')
  })
})
